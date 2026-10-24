import { beforeAll, describe, expect, it } from 'vitest';
import { addDays, weekdayOf } from '../src/domain/dates.js';
import { generateSchedule } from '../src/domain/schedule.js';
import { Client, bootstrapAdmin, createTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestApp>> & { admin: Client };
let ctx: Ctx;

// "Hôm nay" trong test là 2026-10-22 (Thứ 5).
async function actor(role: 'manager' | 'teacher' | 'inspector', email: string) {
  const created = await ctx.admin.post('/api/v1/staff', { email, name: `${role} ${email}`, pin: '123456', roles: [role] });
  expect(created.status).toBe(201);
  const c = new Client(ctx.app);
  expect((await c.post('/api/v1/auth/login', { email, pin: '123456' })).status).toBe(200);
  return { client: c, id: created.body.staff.id as string };
}

let seq = 0;
async function newClass(teacherId: string | null = null, weekdays = [1, 3, 5], extra: Record<string, unknown> = {}) {
  const r = await ctx.admin.post('/api/v1/classes', { name: `Lớp M3 ${++seq}`, slotId: 'toi1', room: '101', teacherId, weekdays, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.class.id as string;
}

async function enroll(opts: { programId: string; classId: string; startDate: string; totalSessions?: number; studentId?: string }) {
  let studentId = opts.studentId;
  if (!studentId) {
    const s = await ctx.admin.post('/api/v1/students', { name: `HV M3 ${++seq}`, birthday: '2018-01-01' });
    studentId = s.body.student.id as string;
  }
  const e = await ctx.admin.post('/api/v1/enrollments', {
    studentId,
    programId: opts.programId,
    classId: opts.classId,
    startDate: opts.startDate,
    ...(opts.totalSessions ? { totalSessions: opts.totalSessions } : {}),
  });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  return { id: e.body.enrollment.id as string, studentId, endDate: e.body.enrollment.progress.endDate as string };
}

const sessionDates = async (enrollmentId: string) =>
  (await ctx.db.query<{ date: string }>('SELECT date::text AS date FROM course_sessions WHERE enrollment_id = $1 ORDER BY date', [enrollmentId])).rows.map((r) => r.date);

async function absent(classId: string, enrollmentId: string, date: string, notified = true) {
  const r = await ctx.admin.req('PUT', '/api/v1/attendance', { classId, date, items: [{ enrollmentId, status: 'absent', notified }] });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

const makeup = (enrollmentId: string, absenceDate: string, date: string, extra: Record<string, unknown> = {}) =>
  ctx.admin.post('/api/v1/makeups', { enrollmentId, absenceDate, date, room: '102', notifiedParent: true, ...extra });
const pending = async (c: Client = ctx.admin) => (await c.get('/api/v1/makeups')).body.pending as { enrollmentId: string; absenceDate: string; minutes: number }[];

beforeAll(async () => {
  const base = await createTestApp();
  ctx = { ...base, admin: await bootstrapAdmin(base.app) };
});

describe('lịch theo giai đoạn (domain)', () => {
  it('mỗi ngày dùng ngày học của giai đoạn chứa nó', () => {
    const s = generateSchedule({
      startDate: '2026-10-05',
      weekdays: [],
      totalSessions: 6,
      segments: [
        { from: '2026-10-05', weekdays: [1, 3, 5] },
        { from: '2026-10-13', weekdays: [2, 4] },
      ],
    });
    // 10-12 (Thứ 2) vẫn thuộc giai đoạn 1; từ 10-13 mới theo Thứ 3-5
    expect(s).toEqual(['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-15']);
  });
});

describe('học bù (NT03–NT07)', () => {
  it('NT03: khóa 36 buổi nhóm bù 90 phút, vắng 1 buổi đã báo → đề xuất 1 lượt, xếp sau buổi cuối, không đổi buổi vắng', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'starters-nen-tang', classId, startDate: '2026-06-01' });
    await absent(classId, e.id, '2026-06-03');

    const p = (await pending()).filter((x) => x.enrollmentId === e.id);
    expect(p).toEqual([expect.objectContaining({ absenceDate: '2026-06-03', minutes: 90 })]);

    // Phải xếp SAU ngày kết thúc buổi chính (docs/02: "buổi 37")
    const early = await makeup(e.id, '2026-06-03', addDays(e.endDate, -1));
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('MAKEUP_DATE_INVALID');

    const ok = await makeup(e.id, '2026-06-03', addDays(e.endDate, 2));
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.makeup).toMatchObject({ minutes: 90, status: 'scheduled', absenceDate: '2026-06-03', quota: { maxCount: 2, used: 1 }, needsReview: false });

    // Buổi vắng gốc không bị đổi, khóa vẫn đủ 36 buổi chính
    const sheet = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classId}&date=2026-06-03`);
    expect(sheet.body.rows[0].record).toMatchObject({ status: 'absent', notified: true });
    expect(await sessionDates(e.id)).toHaveLength(36);
    expect((await pending()).filter((x) => x.enrollmentId === e.id)).toEqual([]);
  });

  it('NT04: vắng 3 buổi đã báo nhưng định mức 2 → chỉ đề xuất/xếp tối đa 2, không mở buổi thứ 3', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'movers-nen-tang', classId, startDate: '2026-06-01' });
    for (const d of ['2026-06-03', '2026-06-05', '2026-06-08']) await absent(classId, e.id, d);

    expect((await pending()).filter((x) => x.enrollmentId === e.id)).toHaveLength(2);
    const end = e.endDate;
    expect((await makeup(e.id, '2026-06-03', addDays(end, 2))).status).toBe(201);
    expect((await makeup(e.id, '2026-06-05', addDays(end, 4))).status).toBe(201);
    const third = await makeup(e.id, '2026-06-08', addDays(end, 6));
    expect(third.status).toBe(422);
    expect(third.body.error.code).toBe('MAKEUP_LIMIT_EXCEEDED');
  });

  it('nghỉ không báo hoặc không phải buổi vắng thì không đủ điều kiện bù; trùng lượt → 409', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'flyers-nen-tang', classId, startDate: '2026-06-01' });
    await absent(classId, e.id, '2026-06-03', false);
    await ctx.admin.req('PUT', '/api/v1/attendance', { classId, date: '2026-06-05', items: [{ enrollmentId: e.id, status: 'present' }] });
    await absent(classId, e.id, '2026-06-08');

    expect((await pending()).filter((x) => x.enrollmentId === e.id).map((x) => x.absenceDate)).toEqual(['2026-06-08']);
    const unnotified = await makeup(e.id, '2026-06-03', addDays(e.endDate, 2));
    expect(unnotified.body.error.code).toBe('MAKEUP_NOT_NOTIFIED');
    const present = await makeup(e.id, '2026-06-05', addDays(e.endDate, 2));
    expect(present.body.error.code).toBe('NOT_ABSENT');

    expect((await makeup(e.id, '2026-06-08', addDays(e.endDate, 2))).status).toBe(201);
    const again = await makeup(e.id, '2026-06-08', addDays(e.endDate, 4));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('MAKEUP_EXISTS');
  });

  it('NT05: Baby/Foundation không có buổi vắng → không có đề xuất bù 30 phút', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'baby-stars', classId, startDate: '2026-09-07' });
    expect((await pending()).filter((x) => x.enrollmentId === e.id)).toEqual([]);
    const profile = await ctx.admin.get(`/api/v1/enrollments`);
    expect(profile.body.enrollments.find((x: { id: string }) => x.id === e.id).makeupQuota).toEqual({ maxCount: 5, minutes: 30 });
  });

  it('NT06: bù 30 phút qua nhiều đợt, gắn vào 5 buổi chính cuối, không trùng buổi vắng, không vượt 5 lượt, hiện ở sổ tháng', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'smart-explorers-1', classId, startDate: '2026-06-01' }); // 24 buổi, 5×30'
    const dates = await sessionDates(e.id);
    expect(dates).toHaveLength(24);
    const last5 = dates.slice(-5);
    const absences = dates.slice(0, 6);
    for (const d of absences) await absent(classId, e.id, d);

    expect((await pending()).filter((x) => x.enrollmentId === e.id)).toHaveLength(5);

    // Đợt 1: 2 lượt; đợt 2: 3 lượt (xếp nhiều lần trong quá trình khóa học)
    expect((await makeup(e.id, absences[0], last5[0])).status).toBe(201);
    expect((await makeup(e.id, absences[1], last5[1])).status).toBe(201);
    for (let i = 2; i < 5; i++) expect((await makeup(e.id, absences[i], last5[i])).status).toBe(201);

    const sixth = await makeup(e.id, absences[5], last5[4]);
    expect(sixth.status).toBe(422);
    expect(sixth.body.error.code).toBe('MAKEUP_LIMIT_EXCEEDED');

    // Ngày phải thuộc 5 buổi chính cuối khóa; mỗi buổi chỉ gắn 1 lượt
    const classId2 = await newClass();
    const f = await enroll({ programId: 'smart-learners-1', classId: classId2, startDate: '2026-06-01' });
    const fd = await sessionDates(f.id);
    await absent(classId2, f.id, fd[0]);
    await absent(classId2, f.id, fd[1]);
    const outside = await makeup(f.id, fd[0], fd[3]);
    expect(outside.status).toBe(422);
    expect(outside.body.error.code).toBe('MAKEUP_DATE_INVALID');
    expect((await makeup(f.id, fd[0], fd[fd.length - 1])).status).toBe(201);
    const taken = await makeup(f.id, fd[1], fd[fd.length - 1]);
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('MAKEUP_DATE_TAKEN');

    // Hiển thị tại buổi chính liên quan (sổ ngày và sổ tháng)
    const sheet = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classId}&date=${last5[0]}`);
    expect(sheet.body.rows[0].makeups).toEqual([expect.objectContaining({ minutes: 30, status: 'scheduled' })]);
    const ledger = await ctx.admin.get(`/api/v1/attendance/ledger?classId=${classId}&month=${last5[0].slice(0, 7)}`);
    const row = ledger.body.rows.find((r: { enrollmentId: string }) => r.enrollmentId === e.id);
    expect(row.cells.find((c: { date: string }) => c.date === last5[0]).makeupMinutes).toBe(30);
  });

  it('NT07: Vắng bù ≠ Hoàn tất; Vắng bù vẫn mất lượt, không tự sinh lượt thay thế; hủy cần lý do và trả lượt', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'pet-foundation-1', classId, startDate: '2026-06-01' });
    for (const d of ['2026-06-03', '2026-06-05', '2026-06-08']) await absent(classId, e.id, d);
    const end = e.endDate;
    const m1 = await makeup(e.id, '2026-06-03', addDays(end, 2));
    const m2 = await makeup(e.id, '2026-06-05', addDays(end, 4));
    const id1 = m1.body.makeup.id as string;
    const id2 = m2.body.makeup.id as string;

    // Chưa tới ngày bù thì chưa ghi kết quả được: dùng bù 1 đã qua (≤ hôm nay), bù 2 ở tương lai
    const future = await makeup(e.id, '2026-06-08', '2026-12-30').catch(() => null);
    expect(future === null || future.status === 422).toBe(true);

    const done = await ctx.admin.patch(`/api/v1/makeups/${id1}`, { status: 'done' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.makeup.status).toBe('done');
    const missed = await ctx.admin.patch(`/api/v1/makeups/${id2}`, { status: 'missed', note: 'Vắng buổi bù đã thông báo' });
    expect(missed.body.makeup.status).toBe('missed');
    expect(missed.body.makeup.quota.used).toBe(2);

    // Hết lượt: buổi vắng thứ 3 không được đề xuất thay thế
    expect((await pending()).filter((x) => x.enrollmentId === e.id)).toEqual([]);
    const retry = await makeup(e.id, '2026-06-05', addDays(end, 8));
    expect(['MAKEUP_EXISTS', 'MAKEUP_LIMIT_EXCEEDED']).toContain(retry.body.error.code);

    const again = await ctx.admin.patch(`/api/v1/makeups/${id1}`, { status: 'missed' });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('hủy lịch bù: bắt buộc lý do, trả lại lượt và buổi vắng được đề xuất lại', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'pet-foundation-2', classId, startDate: '2026-06-01' });
    await absent(classId, e.id, '2026-06-03');
    const m = await makeup(e.id, '2026-06-03', addDays(e.endDate, 2));
    const id = m.body.makeup.id as string;

    const noReason = await ctx.admin.patch(`/api/v1/makeups/${id}`, { status: 'cancelled' });
    expect(noReason.status).toBe(400);
    const cancelled = await ctx.admin.patch(`/api/v1/makeups/${id}`, { status: 'cancelled', note: 'Phụ huynh đổi lịch' });
    expect(cancelled.body.makeup).toMatchObject({ status: 'cancelled', note: 'Phụ huynh đổi lịch' });
    expect((await pending()).filter((x) => x.enrollmentId === e.id)).toHaveLength(1);
    expect((await makeup(e.id, '2026-06-03', addDays(e.endDate, 3))).status).toBe(201);
  });

  it('ghi kết quả buổi bù chỉ khi đã tới ngày bù', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'pet-foundation-3', classId, startDate: '2026-10-05' });
    await absent(classId, e.id, '2026-10-07');
    const m = await makeup(e.id, '2026-10-07', addDays(e.endDate, 2));
    const res = await ctx.admin.patch(`/api/v1/makeups/${m.body.makeup.id}`, { status: 'done' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MAKEUP_NOT_YET');
  });

  it('đổi buổi vắng đã có lịch bù thành Có mặt bị chặn cho tới khi hủy lượt bù', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'ket-foundation-1', classId, startDate: '2026-06-01' });
    await absent(classId, e.id, '2026-06-03');
    const m = await makeup(e.id, '2026-06-03', addDays(e.endDate, 2));
    const fix = { classId, date: '2026-06-03', items: [{ enrollmentId: e.id, status: 'present' }] };

    const blocked = await ctx.admin.req('PUT', '/api/v1/attendance', fix);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('MAKEUP_EXISTS');
    await ctx.admin.patch(`/api/v1/makeups/${m.body.makeup.id}`, { status: 'cancelled', note: 'Ghi nhầm vắng' });
    expect((await ctx.admin.req('PUT', '/api/v1/attendance', fix)).status).toBe(200);
  });

  it('gói chưa có chính sách bù (Lớp 10) → 422; ngày bù trùng ngày nghỉ → 422', async () => {
    const classId = await newClass();
    const g = await enroll({ programId: 'lop10-gd2', classId, startDate: '2026-06-01', totalSessions: 36 });
    await absent(classId, g.id, '2026-06-03');
    const none = await makeup(g.id, '2026-06-03', addDays(g.endDate, 2));
    expect(none.body.error.code).toBe('NO_MAKEUP_POLICY');

    const e = await enroll({ programId: 'ielts-we103', classId, startDate: '2026-06-01' });
    await absent(classId, e.id, '2026-06-03');
    const day = addDays(e.endDate, 3);
    await ctx.admin.post('/api/v1/holidays', { date: day, reason: 'Nghỉ thử bù' });
    const onHoliday = await makeup(e.id, '2026-06-03', day);
    expect(onHoliday.body.error.code).toBe('MAKEUP_ON_HOLIDAY');
    await ctx.admin.req('DELETE', `/api/v1/holidays/${day}`);
  });

  it('phân quyền: giáo viên chỉ xem lượt bù lớp mình và không xếp/đổi; Thanh tra bị từ chối', async () => {
    const teacher = await actor('teacher', 'gv-bu@we.vn');
    const inspector = await actor('inspector', 'tt-bu@we.vn');
    const mine = await newClass(teacher.id);
    const other = await newClass(null);
    const a = await enroll({ programId: 'starters-luyen-de', classId: mine, startDate: '2026-06-01' });
    const b = await enroll({ programId: 'starters-luyen-de', classId: other, startDate: '2026-06-01' });
    await absent(mine, a.id, '2026-06-03');
    await absent(other, b.id, '2026-06-03');
    const m = await makeup(a.id, '2026-06-03', addDays(a.endDate, 2));
    await makeup(b.id, '2026-06-03', addDays(b.endDate, 2));

    const view = await teacher.client.get('/api/v1/makeups');
    expect(view.status).toBe(200);
    expect(view.body.list.map((x: { enrollmentId: string }) => x.enrollmentId)).toEqual([a.id]);
    expect(view.body.pending).toEqual([]);
    expect((await teacher.client.post('/api/v1/makeups', {})).status).toBe(403);
    expect((await teacher.client.patch(`/api/v1/makeups/${m.body.makeup.id}`, { status: 'done' })).status).toBe(403);
    expect((await inspector.client.get('/api/v1/makeups')).status).toBe(403);
  });
});

describe('bảo lưu và nhập học lại (NT10)', () => {
  const reserve = (enrollmentId: string, extra: Record<string, unknown> = {}) =>
    ctx.admin.post('/api/v1/reserves', {
      enrollmentId,
      noticeAt: '2026-10-20T09:00',
      completedOn: '2026-10-26',
      absentStreak: 10,
      amount: 2_000_000,
      note: 'Gia đình đi xa',
      ...extra,
    });

  it('NT10: đủ điều kiện → khóa tạm dừng, buổi sau ngày hiệu lực được gỡ (không sinh buổi vắng), hạn 2 tháng, giá trị theo xác nhận', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'smart-achievers-1', classId, startDate: '2026-10-05' }); // 24 buổi
    const before = await sessionDates(e.id);
    const kept = before.filter((d) => d < '2026-10-26');

    const res = await reserve(e.id);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.reserve).toMatchObject({
      status: 'active',
      completedOn: '2026-10-26',
      expiresOn: '2026-12-26',
      remainingSessions: before.length - kept.length,
      amount: 2_000_000,
      student: expect.objectContaining({ status: 'reserved' }),
    });
    expect(res.body.suggestedAmount).toBe(Math.floor((6_400_000 * (before.length - kept.length)) / 24));
    expect(await sessionDates(e.id)).toEqual(kept);

    const profile = await ctx.admin.get(`/api/v1/students/${e.studentId}`);
    expect(profile.body.enrollments[0].status).toBe('reserved');
    expect(profile.body.reserves).toHaveLength(1);

    // Khóa đang bảo lưu không xuất hiện trong sổ điểm danh và không bị coi là thiếu điểm danh
    const sheet = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classId}&date=2026-10-26`);
    expect(sheet.body.rows).toEqual([]);

    const list = await ctx.admin.get('/api/v1/reserves');
    expect(list.body.reserves.find((r: { id: string }) => r.id === res.body.reserve.id)).toMatchObject({ daysLeft: 65, status: 'active' });
  });

  it('chặn theo chính sách: nghỉ < 10 buổi, báo trước < 48 giờ, quá 1 lần/khóa, vượt học phí, đã điểm danh sau ngày hiệu lực', async () => {
    const classId = await newClass();
    const e = await enroll({ programId: 'smart-achievers-2', classId, startDate: '2026-10-05' });

    const short = await reserve(e.id, { absentStreak: 9 });
    expect(short.status).toBe(422);
    expect(short.body.error.code).toBe('RESERVE_STREAK_TOO_SHORT');

    const lateNotice = await reserve(e.id, { noticeAt: '2026-10-24T20:00' }); // còn 28 giờ tới 00:00 ngày 26
    expect(lateNotice.body.error.code).toBe('RESERVE_NOTICE_TOO_SHORT');
    const exact = await reserve(e.id, { noticeAt: '2026-10-24T00:00', completedOn: '2026-10-26' }); // đúng 48 giờ
    expect(exact.status, JSON.stringify(exact.body)).toBe(201);

    const second = await reserve(e.id, { noticeAt: '2026-10-01T00:00' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('RESERVE_ALREADY_USED');

    const f = await enroll({ programId: 'smart-achievers-3', classId, startDate: '2026-10-05' });
    expect((await reserve(f.id, { amount: 99_000_000 })).body.error.code).toBe('RESERVE_AMOUNT_TOO_HIGH');
    await ctx.admin.req('PUT', '/api/v1/attendance', { classId, date: '2026-10-21', items: [{ enrollmentId: f.id, status: 'present' }] });
    const attended = await reserve(f.id, { completedOn: '2026-10-19', noticeAt: '2026-10-10T09:00' });
    expect(attended.status).toBe(409);
    expect(attended.body.error.code).toBe('RESERVE_HAS_ATTENDANCE');
  });

  it('bảo lưu một khóa không ngừng cả hồ sơ: học viên còn khóa khác đang học vẫn "Đang học"', async () => {
    const classId = await newClass();
    const a = await enroll({ programId: 'ielts-we101', classId, startDate: '2026-10-05' });
    const b = await enroll({ programId: 'pre-ielts-1', classId, startDate: '2026-10-05', studentId: a.studentId });
    expect((await reserve(a.id)).status).toBe(201);
    const profile = await ctx.admin.get(`/api/v1/students/${a.studentId}`);
    expect(profile.body.student.status).toBe('active');
    expect(profile.body.enrollments.map((x: { status: string }) => x.status).sort()).toEqual(['active', 'reserved']);
    expect(b.id).not.toBe(a.id);
  });

  it('nhập học lại: tiếp tục số buổi còn lại ở lớp mới, khoảng bảo lưu không có buổi, ngày nghỉ không làm sống lại khoảng đó', async () => {
    const oldClass = await newClass();
    const newCls = await newClass(null, [2, 4, 6]);
    const e = await enroll({ programId: 'smart-learners-3', classId: oldClass, startDate: '2026-10-05' }); // 24 buổi
    const before = await sessionDates(e.id);
    const kept = before.filter((d) => d < '2026-10-26');
    const created = await reserve(e.id);
    const reserveId = created.body.reserve.id as string;

    const back = await ctx.admin.post(`/api/v1/reserves/${reserveId}/return`, { classId: newCls, returnedOn: '2026-11-17' });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(back.body.reserve).toMatchObject({ status: 'returned', returnedOn: '2026-11-17', returnClassId: newCls });
    expect(back.body.enrollment).toMatchObject({ status: 'active', class: { id: newCls }, totalSessions: 24 });

    const after = await sessionDates(e.id);
    expect(after).toHaveLength(24);
    expect(after.filter((d) => d < '2026-10-26')).toEqual(kept);
    expect(after.some((d) => d >= '2026-10-26' && d < '2026-11-17')).toBe(false); // khoảng bảo lưu: không có buổi
    expect(after.filter((d) => d >= '2026-11-17').every((d) => [2, 4, 6].includes(weekdayOf(d)))).toBe(true);
    const profile = await ctx.admin.get(`/api/v1/students/${e.studentId}`);
    expect(profile.body.student.status).toBe('active');

    // Thêm ngày nghỉ rơi vào khoảng bảo lưu cũ: lịch không được sinh lại trong khoảng đó
    expect((await ctx.admin.post('/api/v1/holidays', { date: '2026-11-03', reason: 'Nghỉ thử trong khoảng bảo lưu' })).status).toBe(201);
    const again = await sessionDates(e.id);
    expect(again).toHaveLength(24);
    expect(again.some((d) => d >= '2026-10-26' && d < '2026-11-17')).toBe(false);
    await ctx.admin.req('DELETE', '/api/v1/holidays/2026-11-03');
  });

  it('quá hạn 2 tháng: giá trị hết hiệu lực, không nhập học lại được, học viên chuyển Đã nghỉ; ngày quay lại đúng hạn cuối vẫn được', async () => {
    const classId = await newClass();
    const late = await enroll({ programId: 'smart-learners-2', classId, startDate: '2026-06-01' });
    const lateRes = await reserve(late.id, { completedOn: '2026-07-10', noticeAt: '2026-07-01T09:00' }); // hạn 2026-09-10 (đã qua)
    expect(lateRes.status, JSON.stringify(lateRes.body)).toBe(201);

    const list = await ctx.admin.get('/api/v1/reserves');
    expect(list.body.reserves.find((r: { id: string }) => r.id === lateRes.body.reserve.id)).toMatchObject({ status: 'expired', daysLeft: null });
    const profile = await ctx.admin.get(`/api/v1/students/${late.studentId}`);
    expect(profile.body.student.status).toBe('left');
    const denied = await ctx.admin.post(`/api/v1/reserves/${lateRes.body.reserve.id}/return`, { classId, returnedOn: '2026-10-22' });
    expect(denied.status).toBe(422);
    expect(denied.body.error.code).toBe('RESERVE_EXPIRED');

    const edge = await enroll({ programId: 'smart-learners-1', classId, startDate: '2026-10-05' });
    const ok = await reserve(edge.id, { completedOn: '2026-10-26', noticeAt: '2026-10-20T09:00' });
    const onLastDay = await ctx.admin.post(`/api/v1/reserves/${ok.body.reserve.id}/return`, { classId, returnedOn: '2026-12-26' });
    expect(onLastDay.status, JSON.stringify(onLastDay.body)).toBe(200);
  });

  it('quay lại: lớp đủ sĩ số hoặc ngày trước ngày bảo lưu bị chặn; chỉ Admin/Manager thao tác', async () => {
    const teacher = await actor('teacher', 'gv-bl@we.vn');
    const classId = await newClass();
    const full = await newClass(null, [1, 3, 5], { maxSize: 1 });
    await enroll({ programId: 'ielts-we102', classId: full, startDate: '2026-10-05' });
    const e = await enroll({ programId: 'smart-learners-1', classId, startDate: '2026-10-05' });
    const r = await reserve(e.id);
    const id = r.body.reserve.id as string;

    const crowded = await ctx.admin.post(`/api/v1/reserves/${id}/return`, { classId: full, returnedOn: '2026-11-17' });
    expect(crowded.body.error.code).toBe('CLASS_FULL');
    expect((await ctx.admin.post(`/api/v1/reserves/${id}/return`, { classId, returnedOn: '2026-10-20' })).status).toBe(400);
    expect((await teacher.client.get('/api/v1/reserves')).status).toBe(403);
    expect((await teacher.client.post('/api/v1/reserves', {})).status).toBe(403);
  });
});

describe('chuyển lớp (NT09)', () => {
  it('NT09: giữ lịch sử lớp cũ và quyền học còn lại; buổi sau ngày hiệu lực theo lớp mới; vẫn đủ định mức', async () => {
    const classA = await newClass(null, [1, 3, 5]);
    const classB = await newClass(null, [2, 4, 6]);
    const e = await enroll({ programId: 'smart-explorers-2', classId: classA, startDate: '2026-10-05' }); // 24 buổi
    await ctx.admin.req('PUT', '/api/v1/attendance', { classId: classA, date: '2026-10-21', items: [{ enrollmentId: e.id, status: 'absent', notified: true }] });
    const original = await sessionDates(e.id);
    const futureCount = original.filter((d) => d >= '2026-10-26').length;

    const res = await ctx.admin.post(`/api/v1/enrollments/${e.id}/transfer`, { toClassId: classB, effectiveDate: '2026-10-26', note: 'Đổi giờ học' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.transfer).toMatchObject({ fromClassId: classA, toClassId: classB, effectiveDate: '2026-10-26', remainingSessions: futureCount });
    expect(res.body.enrollment).toMatchObject({ class: { id: classB }, totalSessions: 24, status: 'active' });

    const rows = (await ctx.db.query<{ date: string; class_id: string }>('SELECT date::text AS date, class_id::text AS class_id FROM course_sessions WHERE enrollment_id = $1 ORDER BY date', [e.id])).rows;
    expect(rows).toHaveLength(24);
    expect(rows.filter((r) => r.date < '2026-10-26').every((r) => r.class_id === classA && [1, 3, 5].includes(weekdayOf(r.date)))).toBe(true);
    const moved = rows.filter((r) => r.date >= '2026-10-26');
    expect(moved.length).toBe(futureCount);
    expect(moved.every((r) => r.class_id === classB && [2, 4, 6].includes(weekdayOf(r.date)))).toBe(true);

    // Điểm danh cũ vẫn thuộc lớp cũ
    const oldSheet = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classA}&date=2026-10-21`);
    expect(oldSheet.body.rows[0].record).toMatchObject({ status: 'absent' });
    const transfers = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM transfers WHERE enrollment_id = $1', [e.id]);
    expect(transfers.rows[0].n).toBe(1);
    expect((await ctx.admin.get(`/api/v1/students/${e.studentId}`)).body.enrollments).toHaveLength(1); // không tạo khóa mới
  });

  it('ngày nghỉ sau khi chuyển lớp vẫn tôn trọng ngày học của từng giai đoạn', async () => {
    const classA = await newClass(null, [1, 3, 5]);
    const classB = await newClass(null, [2, 4]);
    const e = await enroll({ programId: 'smart-performers-1', classId: classA, startDate: '2026-10-05' });
    await ctx.admin.post(`/api/v1/enrollments/${e.id}/transfer`, { toClassId: classB, effectiveDate: '2026-11-02' });

    expect((await ctx.admin.post('/api/v1/holidays', { date: '2026-10-28', reason: 'Nghỉ trước ngày chuyển' })).status).toBe(201);
    const rows = (await ctx.db.query<{ date: string; class_id: string }>('SELECT date::text AS date, class_id::text AS class_id FROM course_sessions WHERE enrollment_id = $1 ORDER BY date', [e.id])).rows;
    expect(rows).toHaveLength(24);
    for (const r of rows) {
      if (r.date < '2026-11-02') expect([1, 3, 5].includes(weekdayOf(r.date)) && r.class_id === classA).toBe(true);
      else expect([2, 4].includes(weekdayOf(r.date)) && r.class_id === classB).toBe(true);
    }
    expect(rows.map((r) => r.date)).not.toContain('2026-10-28');
    await ctx.admin.req('DELETE', '/api/v1/holidays/2026-10-28');
  });

  it('chặn: cùng lớp, ngày hiệu lực đã qua, lớp đủ sĩ số, lớp chưa có ngày học, khóa đang bảo lưu, người không có quyền', async () => {
    const teacher = await actor('teacher', 'gv-cl@we.vn');
    const classA = await newClass();
    const classB = await newClass();
    const full = await newClass(null, [1, 3, 5], { maxSize: 1 });
    await enroll({ programId: 'ielts-we101', classId: full, startDate: '2026-10-05' });
    const e = await enroll({ programId: 'smart-explorers-3', classId: classA, startDate: '2026-10-05' });
    const url = `/api/v1/enrollments/${e.id}/transfer`;

    expect((await ctx.admin.post(url, { toClassId: classA, effectiveDate: '2026-10-26' })).body.error.code).toBe('SAME_CLASS');
    expect((await ctx.admin.post(url, { toClassId: classB, effectiveDate: '2026-10-21' })).body.error.code).toBe('TRANSFER_IN_PAST');
    expect((await ctx.admin.post(url, { toClassId: full, effectiveDate: '2026-10-26' })).body.error.code).toBe('CLASS_FULL');
    const empty = await ctx.db.query<{ id: string }>("INSERT INTO classes (name, slot_id, room) VALUES ('Lớp trống ngày', 'toi1', '101') RETURNING id::text AS id");
    expect((await ctx.admin.post(url, { toClassId: empty.rows[0].id, effectiveDate: '2026-10-26' })).body.error.code).toBe('NO_WEEKDAYS');
    expect((await teacher.client.post(url, { toClassId: classB, effectiveDate: '2026-10-26' })).status).toBe(403);

    expect((await ctx.admin.post('/api/v1/reserves', { enrollmentId: e.id, noticeAt: '2026-10-20T09:00', completedOn: '2026-10-26', absentStreak: 10, amount: 0 })).status).toBe(201);
    expect((await ctx.admin.post(url, { toClassId: classB, effectiveDate: '2026-11-02' })).body.error.code).toBe('ENROLLMENT_NOT_ACTIVE');
  });
});
