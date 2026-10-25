import { beforeAll, describe, expect, it } from 'vitest';
import { Client, bootstrapAdmin, createTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestApp>> & { admin: Client };
let ctx: Ctx;
let seq = 0;

async function newClass() {
  const r = await ctx.admin.post('/api/v1/classes', { name: `Lớp SỬA ${++seq}`, slotId: 'toi1', room: '101', weekdays: [1, 3, 5] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.class.id as string;
}

/** Hôm nay (test) là 2026-10-22 (thứ Năm). Lớp học Thứ 2-4-6 nên 8 buổi đầu (05→21/10) đã diễn ra. */
async function enroll(opts: { classId?: string; startDate?: string; totalSessions?: number; programId?: string } = {}) {
  const classId = opts.classId ?? (await newClass());
  const s = await ctx.admin.post('/api/v1/students', { name: `HV SỬA ${++seq}`, birthday: '2018-01-01' });
  const e = await ctx.admin.post('/api/v1/enrollments', {
    studentId: s.body.student.id,
    programId: opts.programId ?? 'smart-explorers-1',
    classId,
    startDate: opts.startDate ?? '2026-10-05',
    totalSessions: opts.totalSessions ?? 12,
  });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  return { id: e.body.enrollment.id as string, studentId: s.body.student.id as string, classId };
}

const patch = (id: string, body: Record<string, unknown>) => ctx.admin.req('PATCH', `/api/v1/enrollments/${id}`, body);
const sessions = async (id: string) => (await ctx.db.query<{ date: string }>('SELECT date::text AS date FROM course_sessions WHERE enrollment_id = $1 ORDER BY date', [id])).rows.map((r) => r.date);
const mark = (classId: string, enrollmentId: string, date: string, status: string, notified = false) =>
  ctx.admin.req('PUT', '/api/v1/attendance', { classId, date, items: [{ enrollmentId, status, notified }] });

beforeAll(async () => {
  const base = await createTestApp();
  ctx = { ...base, admin: await bootstrapAdmin(base.app) };
});

describe('sửa khóa đăng ký', () => {
  it('đánh dấu đã nhận học phí, đổi học phí và ghi chú; không đụng lịch học', async () => {
    const e = await enroll();
    const before = await sessions(e.id);
    const res = await patch(e.id, { tuitionReceived: true, tuition: 5_000_000, note: 'Giảm 10%' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.enrollment).toMatchObject({ tuitionReceived: true, tuition: 5_000_000, note: 'Giảm 10%' });
    expect(await sessions(e.id)).toEqual(before);
    expect((await patch(e.id, { tuitionReceived: false })).body.enrollment.tuitionReceived).toBe(false);

    const log = await ctx.db.query<{ detail: { before: { tuitionReceived: boolean } } }>("SELECT detail FROM audit_log WHERE entity = 'enrollment' AND entity_id = $1 AND action = 'update' ORDER BY id", [e.id]);
    expect(log.rows).toHaveLength(2);
    expect(log.rows[0].detail.before.tuitionReceived).toBe(false);
  });

  it('kiểm tra dữ liệu và quyền: rỗng, học phí âm, giáo viên bị chặn', async () => {
    const e = await enroll();
    expect((await patch(e.id, {})).status).toBe(400);
    expect((await patch(e.id, { tuition: -1 })).status).toBe(400);
    expect((await patch('999999', { note: 'x' })).status).toBe(404);
    await ctx.admin.post('/api/v1/staff', { email: 'gv-sua@we.vn', name: 'GV', pin: '123456', roles: ['teacher'] });
    const t = new Client(ctx.app);
    await t.post('/api/v1/auth/login', { email: 'gv-sua@we.vn', pin: '123456' });
    expect((await t.req('PATCH', `/api/v1/enrollments/${e.id}`, { note: 'x' })).status).toBe(403);
  });

  it('tăng tổng số buổi: kéo dài lịch, giữ nguyên buổi đã qua và buổi đã điểm danh', async () => {
    const e = await enroll({ totalSessions: 12 });
    expect((await mark(e.classId, e.id, '2026-10-21', 'present')).status).toBe(200);
    const before = await sessions(e.id);
    const done = before.filter((d) => d <= '2026-10-22');

    const res = await patch(e.id, { totalSessions: 16 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = await sessions(e.id);
    expect(after).toHaveLength(16);
    expect(after.slice(0, done.length)).toEqual(done);
    expect(res.body.enrollment.progress.total).toBe(16);
    expect(res.body.enrollment.progress.endDate).toBe(after[after.length - 1]);
    expect(res.body.enrollment.progress.endDate > before[before.length - 1]).toBe(true);
    // điểm danh cũ còn nguyên
    const sheet = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${e.classId}&date=2026-10-21`);
    expect(sheet.body.rows.find((r: { enrollmentId: string }) => r.enrollmentId === e.id).record.status).toBe('present');
  });

  it('giảm tổng số buổi: được nếu không thấp hơn số buổi đã diễn ra; thấp hơn thì bị chặn', async () => {
    const e = await enroll({ totalSessions: 12 }); // 8 buổi đã diễn ra tính đến 22/10
    const low = await patch(e.id, { totalSessions: 5 });
    expect(low.status).toBe(422);
    expect(low.body.error.code).toBe('TOTAL_BELOW_HELD');
    expect((await sessions(e.id)).length).toBe(12);

    const ok = await patch(e.id, { totalSessions: 10 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await sessions(e.id)).toHaveLength(10);
  });

  it('đổi ngày bắt đầu khi chưa có điểm danh: lịch lập lại từ ngày mới; đã có điểm danh thì bị khóa', async () => {
    const e = await enroll({ startDate: '2026-10-05', totalSessions: 12 });
    const moved = await patch(e.id, { startDate: '2026-10-12' });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const s = await sessions(e.id);
    expect(s).toHaveLength(12);
    expect(s[0]).toBe('2026-10-12');
    expect(moved.body.enrollment.startDate).toBe('2026-10-12');

    expect((await mark(e.classId, e.id, '2026-10-14', 'present')).status).toBe(200);
    const locked = await patch(e.id, { startDate: '2026-10-19' });
    expect(locked.status).toBe(422);
    expect(locked.body.error.code).toBe('START_LOCKED');
    expect((await sessions(e.id))[0]).toBe('2026-10-12');
  });

  it('kết thúc khóa: bỏ các buổi chưa tới, giữ lịch sử; khóa kết thúc không sửa cấu trúc được nữa', async () => {
    const e = await enroll({ totalSessions: 12 });
    await mark(e.classId, e.id, '2026-10-21', 'absent', true);
    const res = await patch(e.id, { status: 'completed' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.enrollment.status).toBe('completed');
    const s = await sessions(e.id);
    expect(s.every((d) => d <= '2026-10-22')).toBe(true);
    expect(s).toContain('2026-10-21');

    const again = await patch(e.id, { totalSessions: 20 });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('ENROLLMENT_NOT_ACTIVE');
    // học phí vẫn sửa được sau khi kết thúc
    expect((await patch(e.id, { tuitionReceived: true })).status).toBe(200);
  });

  it('không kết thúc khóa khi còn lượt bù đã xếp chưa tới', async () => {
    const e = await enroll({ totalSessions: 12 });
    await mark(e.classId, e.id, '2026-10-12', 'absent', true);
    const all = await sessions(e.id);
    const mk = await ctx.admin.post('/api/v1/makeups', { enrollmentId: e.id, absenceDate: '2026-10-12', date: all[all.length - 1], room: '102', notifiedParent: true });
    expect(mk.status, JSON.stringify(mk.body)).toBe(201);
    const res = await patch(e.id, { status: 'completed' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('HAS_SCHEDULED_MAKEUPS');
    expect((await ctx.admin.get('/api/v1/enrollments')).body.enrollments.find((x: { id: string }) => x.id === e.id).status).toBe('active');
  });
});

describe('đánh dấu học viên nghỉ học', () => {
  it('bị chặn khi còn khóa đang học; được sau khi kết thúc khóa; học viên nghỉ không đăng ký khóa mới; mở lại được', async () => {
    const e = await enroll();
    const blocked = await ctx.admin.req('PATCH', `/api/v1/students/${e.studentId}`, { status: 'left' });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.code).toBe('STUDENT_HAS_ACTIVE_ENROLLMENTS');

    await patch(e.id, { status: 'completed' });
    const ok = await ctx.admin.req('PATCH', `/api/v1/students/${e.studentId}`, { status: 'left' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.student.status).toBe('left');

    const again = await ctx.admin.post('/api/v1/enrollments', { studentId: e.studentId, programId: 'smart-explorers-1', classId: e.classId, startDate: '2026-10-26', totalSessions: 12 });
    expect(again.status).toBe(422);
    expect(again.body.error.code).toBe('STUDENT_LEFT');

    const back = await ctx.admin.req('PATCH', `/api/v1/students/${e.studentId}`, { status: 'active' });
    expect(back.body.student.status).toBe('active');
  });
});
