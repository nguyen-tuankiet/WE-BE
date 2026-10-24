import { beforeAll, describe, expect, it } from 'vitest';
import { Client, bootstrapAdmin, createTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestApp>> & { admin: Client };
let ctx: Ctx;

// "Hôm nay" trong test là 2026-10-22 (Thứ 5). Lớp học Thứ 2-4-6, bắt đầu 2026-10-05:
// buổi: 10-05, 10-07, 10-09, 10-12, 10-14, 10-16, 10-19, 10-21, 10-23, …
const D = { last: '2026-10-21', mon: '2026-10-19', old: '2026-10-14', future: '2026-10-23', offDay: '2026-10-20' };

async function actor(role: 'manager' | 'teacher' | 'inspector', email: string) {
  const created = await ctx.admin.post('/api/v1/staff', { email, name: `${role} ${email}`, pin: '123456', roles: [role] });
  expect(created.status).toBe(201);
  const c = new Client(ctx.app);
  expect((await c.post('/api/v1/auth/login', { email, pin: '123456' })).status).toBe(200);
  return { client: c, id: created.body.staff.id as string };
}

async function setup(teacherId: string | null, studentCount = 3, totalSessions?: number) {
  const cls = await ctx.admin.post('/api/v1/classes', { name: `Điểm danh ${Math.random().toString(36).slice(2, 6)}`, slotId: 'toi1', room: '101', teacherId, weekdays: [1, 3, 5] });
  expect(cls.status).toBe(201);
  const classId = cls.body.class.id as string;
  const enrollments: { id: string; studentId: string }[] = [];
  for (let i = 0; i < studentCount; i++) {
    const s = await ctx.admin.post('/api/v1/students', { name: `HS ${String.fromCharCode(65 + i)} ${Math.random().toString(36).slice(2, 5)}`, birthday: '2018-01-01' });
    const e = await ctx.admin.post('/api/v1/enrollments', {
      studentId: s.body.student.id,
      programId: 'smart-explorers-1',
      classId,
      startDate: '2026-10-05',
      ...(totalSessions ? { totalSessions } : {}),
    });
    expect(e.status, JSON.stringify(e.body)).toBe(201);
    enrollments.push({ id: e.body.enrollment.id, studentId: s.body.student.id });
  }
  return { classId, enrollments };
}

const save = (c: Client, classId: string, date: string, items: unknown[]) => c.req('PUT', '/api/v1/attendance', { classId, date, items });

beforeAll(async () => {
  const base = await createTestApp();
  ctx = { ...base, admin: await bootstrapAdmin(base.app) };
});

describe('sổ ngày', () => {
  it('liệt kê học viên có buổi ngày đó của lớp; chưa ghi nhận thì record = null (không suy đoán)', async () => {
    const { classId } = await setup(null);
    const sheet = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classId}&date=${D.last}`);
    expect(sheet.status).toBe(200);
    expect(sheet.body.rows).toHaveLength(3);
    expect(sheet.body.rows.every((r: { record: unknown }) => r.record === null)).toBe(true);
    expect(sheet.body).toMatchObject({ editable: true, lockReason: null, teacherEditDays: 3 });

    const off = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classId}&date=${D.offDay}`);
    expect(off.body.rows).toEqual([]);
  });

  it('chỉ Admin/Manager/Giáo viên: Thanh tra bị từ chối; chưa đăng nhập 401; tham số sai 400/404', async () => {
    const inspector = await actor('inspector', 'tt-dd@we.vn');
    const { classId } = await setup(null);
    expect((await inspector.client.get(`/api/v1/attendance/sheet?classId=${classId}&date=${D.last}`)).status).toBe(403);
    expect((await new Client(ctx.app).get(`/api/v1/attendance/sheet?classId=${classId}&date=${D.last}`)).status).toBe(401);
    expect((await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classId}&date=2026/10/21`)).status).toBe(400);
    expect((await ctx.admin.get(`/api/v1/attendance/sheet?classId=abc&date=${D.last}`)).status).toBe(404);
    expect((await ctx.admin.get(`/api/v1/attendance/sheet?classId=999999&date=${D.last}`)).status).toBe(404);
  });
});

describe('ghi điểm danh (NT02)', () => {
  it('NT02: Đi trễ tính đã học, Vắng vẫn nằm trong định mức và giữ trạng thái riêng', async () => {
    const { classId, enrollments } = await setup(null);
    const [a, b, c] = enrollments;
    const res = await save(ctx.admin, classId, D.last, [
      { enrollmentId: a.id, status: 'present' },
      { enrollmentId: b.id, status: 'late', note: 'Đến trễ 10 phút' },
      { enrollmentId: c.id, status: 'absent', notified: true, note: 'Xin nghỉ ốm' },
    ]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ saved: 3, changed: 3 });

    const sheet = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classId}&date=${D.last}`);
    const byEnrollment = new Map(sheet.body.rows.map((r: { enrollmentId: string; record: unknown }) => [r.enrollmentId, r.record]));
    expect(byEnrollment.get(a.id)).toMatchObject({ status: 'present', notified: false });
    expect(byEnrollment.get(b.id)).toMatchObject({ status: 'late', note: 'Đến trễ 10 phút' });
    expect(byEnrollment.get(c.id)).toMatchObject({ status: 'absent', notified: true, note: 'Xin nghỉ ốm' });

    // Buổi vắng vẫn tính trong định mức: tổng số buổi không đổi, buổi đã ghi nhận tăng
    const profile = await ctx.admin.get(`/api/v1/students/${c.studentId}`);
    expect(profile.body.enrollments[0].progress).toMatchObject({ total: 24, recorded: 1 });
    expect(profile.body.attendance).toEqual({ present: 0, late: 0, absent: 1 });
    const lateProfile = await ctx.admin.get(`/api/v1/students/${b.studentId}`);
    expect(lateProfile.body.attendance).toEqual({ present: 0, late: 1, absent: 0 });
  });

  it('kiểm tra đầu vào: Báo nghỉ chỉ cho buổi Vắng, trùng học viên, danh sách rỗng, trạng thái lạ', async () => {
    const { classId, enrollments } = await setup(null, 2);
    const [a] = enrollments;
    const notifiedPresent = await save(ctx.admin, classId, D.last, [{ enrollmentId: a.id, status: 'present', notified: true }]);
    expect(notifiedPresent.status).toBe(400);
    expect((await save(ctx.admin, classId, D.last, [])).status).toBe(400);
    expect((await save(ctx.admin, classId, D.last, [{ enrollmentId: a.id, status: 'sick' }])).status).toBe(400);
    const dup = await save(ctx.admin, classId, D.last, [
      { enrollmentId: a.id, status: 'present' },
      { enrollmentId: a.id, status: 'late' },
    ]);
    expect(dup.status).toBe(400);
  });

  it('không ghi vào ngày ngoài lịch khóa hoặc học viên không thuộc lớp; không ghi ngày chưa tới', async () => {
    const one = await setup(null, 1);
    const two = await setup(null, 1);
    const off = await save(ctx.admin, one.classId, D.offDay, [{ enrollmentId: one.enrollments[0].id, status: 'present' }]);
    expect(off.status).toBe(422);
    expect(off.body.error.code).toBe('OUT_OF_SCHEDULE');

    const wrongClass = await save(ctx.admin, one.classId, D.last, [{ enrollmentId: two.enrollments[0].id, status: 'present' }]);
    expect(wrongClass.status).toBe(422);
    expect(wrongClass.body.error.code).toBe('OUT_OF_SCHEDULE');

    const future = await save(ctx.admin, one.classId, D.future, [{ enrollmentId: one.enrollments[0].id, status: 'present' }]);
    expect(future.status).toBe(422);
    expect(future.body.error.code).toBe('FUTURE_DATE');
  });

  it('lưu lặp không nhân đôi: cùng nội dung → 0 thay đổi; sửa Vắng→Có mặt ghi nhật ký trước/sau', async () => {
    const { classId, enrollments } = await setup(null, 1);
    const [a] = enrollments;
    const absent = [{ enrollmentId: a.id, status: 'absent', notified: true, note: 'Xin nghỉ' }];

    expect((await save(ctx.admin, classId, D.last, absent)).body).toEqual({ saved: 1, changed: 1 });
    expect((await save(ctx.admin, classId, D.last, absent)).body).toEqual({ saved: 1, changed: 0 });
    const rows = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM attendance WHERE enrollment_id = $1', [a.id]);
    expect(rows.rows[0].n).toBe(1);

    const fix = await save(ctx.admin, classId, D.last, [{ enrollmentId: a.id, status: 'present' }]);
    expect(fix.body).toEqual({ saved: 1, changed: 1 });
    const log = await ctx.db.query<{ action: string; detail: { before: { status: string } | null; after: { status: string } } }>(
      "SELECT action, detail FROM audit_log WHERE entity = 'attendance' AND entity_id = $1 ORDER BY id",
      [`${a.id}|${D.last}`],
    );
    expect(log.rows.map((r) => r.action)).toEqual(['create', 'update']);
    expect(log.rows[1].detail.before?.status).toBe('absent');
    expect(log.rows[1].detail.after.status).toBe('present');
  });

  it('lỗi giữa chừng thì không lưu dở: một học viên sai → không học viên nào được ghi', async () => {
    const good = await setup(null, 2);
    const other = await setup(null, 1);
    const res = await save(ctx.admin, good.classId, D.last, [
      { enrollmentId: good.enrollments[0].id, status: 'present' },
      { enrollmentId: other.enrollments[0].id, status: 'present' },
    ]);
    expect(res.status).toBe(422);
    const n = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM attendance WHERE enrollment_id = $1', [good.enrollments[0].id]);
    expect(n.rows[0].n).toBe(0);
  });
});

describe('phân quyền điểm danh theo lớp và thời gian (NT15)', () => {
  it('giáo viên chỉ điểm danh lớp được phân công; lớp khác → 403 FORBIDDEN_CLASS', async () => {
    const mine = await actor('teacher', 'gv-dd1@we.vn');
    const other = await actor('teacher', 'gv-dd2@we.vn');
    const { classId, enrollments } = await setup(mine.id, 1);
    const items = [{ enrollmentId: enrollments[0].id, status: 'present' }];

    expect((await save(mine.client, classId, D.last, items)).status).toBe(200);
    const denied = await save(other.client, classId, D.last, items);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN_CLASS');
    expect((await other.client.get(`/api/v1/attendance/sheet?classId=${classId}&date=${D.last}`)).status).toBe(403);
    expect((await other.client.get(`/api/v1/attendance/ledger?classId=${classId}&month=2026-10`)).status).toBe(403);
  });

  it('giáo viên chỉ sửa trong cửa sổ cấu hình (mặc định 3 ngày); Admin sửa được ngày cũ; đổi cấu hình thì áp dụng ngay', async () => {
    const teacher = await actor('teacher', 'gv-dd3@we.vn');
    const { classId, enrollments } = await setup(teacher.id, 1);
    const items = [{ enrollmentId: enrollments[0].id, status: 'late' }];

    expect((await save(teacher.client, classId, D.mon, items)).status).toBe(200); // cách 3 ngày: còn trong cửa sổ
    const expired = await save(teacher.client, classId, D.old, items); // cách 8 ngày
    expect(expired.status).toBe(403);
    expect(expired.body.error.code).toBe('EDIT_WINDOW_EXPIRED');

    const sheet = await teacher.client.get(`/api/v1/attendance/sheet?classId=${classId}&date=${D.old}`);
    expect(sheet.body).toMatchObject({ editable: false, lockReason: 'EDIT_WINDOW_EXPIRED' });
    const adminSheet = await ctx.admin.get(`/api/v1/attendance/sheet?classId=${classId}&date=${D.old}`);
    expect(adminSheet.body.editable).toBe(true);
    expect((await save(ctx.admin, classId, D.old, items)).status).toBe(200);

    expect((await ctx.admin.req('PUT', '/api/v1/settings', { teacherEditDays: 10 })).status).toBe(200);
    expect((await save(teacher.client, classId, D.old, [{ enrollmentId: enrollments[0].id, status: 'present' }])).status).toBe(200);
    await ctx.admin.req('PUT', '/api/v1/settings', { teacherEditDays: 3 });
  });
});

describe('sổ tháng và tiến độ khóa', () => {
  it('sổ tháng: mỗi ô một buổi; Chưa ghi nhận ≠ Có mặt; buổi chưa tới là future', async () => {
    const { classId, enrollments } = await setup(null, 2);
    await save(ctx.admin, classId, D.last, [{ enrollmentId: enrollments[0].id, status: 'absent', notified: true }]);
    await save(ctx.admin, classId, D.mon, [{ enrollmentId: enrollments[0].id, status: 'present' }]);

    const ledger = await ctx.admin.get(`/api/v1/attendance/ledger?classId=${classId}&month=2026-10`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.dates.slice(0, 3)).toEqual(['2026-10-05', '2026-10-07', '2026-10-09']);
    expect(ledger.body.rows).toHaveLength(2);

    const cell = (row: { cells: { date: string; status: string; notified: boolean }[] }, date: string) => row.cells.find((x) => x.date === date)!;
    const first = ledger.body.rows.find((r: { enrollmentId: string }) => r.enrollmentId === enrollments[0].id);
    const second = ledger.body.rows.find((r: { enrollmentId: string }) => r.enrollmentId === enrollments[1].id);
    expect(cell(first, D.last)).toMatchObject({ status: 'absent', notified: true });
    expect(cell(first, D.mon).status).toBe('present');
    expect(cell(first, '2026-10-12').status).toBe('none'); // đã qua mà chưa ghi nhận
    expect(cell(second, D.last).status).toBe('none');
    expect(cell(first, D.future).status).toBe('future');

    expect((await ctx.admin.get(`/api/v1/attendance/ledger?classId=${classId}&month=2026-13`)).status).toBe(400);
  });

  it('tiến độ khóa: số buổi theo lịch đã qua, đã ghi nhận, thiếu điểm danh (không tự suy đoán)', async () => {
    const { classId, enrollments } = await setup(null, 1);
    const [a] = enrollments;
    await save(ctx.admin, classId, D.last, [{ enrollmentId: a.id, status: 'present' }]);
    await save(ctx.admin, classId, D.mon, [{ enrollmentId: a.id, status: 'late' }]);

    const list = await ctx.admin.get('/api/v1/enrollments');
    const p = list.body.enrollments.find((e: { id: string }) => e.id === a.id).progress;
    // Buổi đã qua tính đến 2026-10-22: 10-05, 07, 09, 12, 14, 16, 19, 21 = 8 buổi
    expect(p).toMatchObject({ total: 24, held: 8, remaining: 16, recorded: 2, missing: 6, firstMissingDate: '2026-10-05' });
  });
});

describe('dời lịch không bao giờ động vào buổi đã điểm danh', () => {
  it('ngày nghỉ mới: buổi đã có điểm danh giữ nguyên, số thứ tự liền mạch, vẫn đủ định mức; ngày có điểm danh không thể thành ngày nghỉ', async () => {
    const { classId, enrollments } = await setup(null, 1, 12);
    const [a] = enrollments;
    await save(ctx.admin, classId, D.mon, [{ enrollmentId: a.id, status: 'present' }]);

    const blocked = await ctx.admin.post('/api/v1/holidays', { date: D.mon, reason: 'Đã có điểm danh' });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('HOLIDAY_HAS_ATTENDANCE');

    // Ngày nghỉ ở quá khứ, trước buổi đã điểm danh: các buổi sau đó dời, riêng 10-19 (đã điểm danh) đứng yên
    const added = await ctx.admin.post('/api/v1/holidays', { date: '2026-10-12', reason: 'Nghỉ đột xuất' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const rows = await ctx.db.query<{ date: string; seq: number }>('SELECT date::text AS date, seq FROM course_sessions WHERE enrollment_id = $1 ORDER BY date', [a.id]);
    expect(rows.rows).toHaveLength(12);
    expect(rows.rows.map((r) => r.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(rows.rows.map((r) => r.date)).toContain(D.mon);
    expect(rows.rows.map((r) => r.date)).not.toContain('2026-10-12');
    expect(new Set(rows.rows.map((r) => r.date)).size).toBe(12);

    const kept = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM attendance WHERE enrollment_id = $1 AND date = $2::date', [a.id, D.mon]);
    expect(kept.rows[0].n).toBe(1);

    expect((await ctx.admin.req('DELETE', '/api/v1/holidays/2026-10-12')).status).toBe(200);
    const restored = await ctx.db.query<{ date: string }>('SELECT date::text AS date FROM course_sessions WHERE enrollment_id = $1 ORDER BY seq', [a.id]);
    expect(restored.rows).toHaveLength(12);
    expect(restored.rows.map((r) => r.date)).toContain('2026-10-12');
    expect(restored.rows.map((r) => r.date)).toContain(D.mon);
  });
});
