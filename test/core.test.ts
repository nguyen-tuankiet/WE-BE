import { beforeAll, describe, expect, it } from 'vitest';
import { weekdayOf } from '../src/domain/dates.js';
import { Client, TEST_TODAY, bootstrapAdmin, createTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestApp>> & { admin: Client };
let ctx: Ctx;

async function actor(role: 'manager' | 'teacher' | 'inspector', email: string) {
  const created = await ctx.admin.post('/api/v1/staff', { email, name: `${role} ${email}`, pin: '123456', roles: [role] });
  expect(created.status).toBe(201);
  const c = new Client(ctx.app);
  expect((await c.post('/api/v1/auth/login', { email, pin: '123456' })).status).toBe(200);
  return { client: c, id: created.body.staff.id as string };
}

async function newStudent(name = 'Học Viên Thử', extra: Record<string, unknown> = {}) {
  const res = await ctx.admin.post('/api/v1/students', { name, birthday: '2018-05-20', guardian: 'Chị Lan', phone: '0912345678', ...extra });
  expect(res.status).toBe(201);
  return res.body.student as { id: string; code: string };
}

async function newClass(teacherId: string | null, extra: Record<string, unknown> = {}) {
  const res = await ctx.admin.post('/api/v1/classes', {
    name: `Lớp ${Math.random().toString(36).slice(2, 7)}`,
    subject: 'Kids Foundation',
    slotId: 'toi1',
    room: '101',
    teacherId,
    weekdays: [1, 3, 5],
    maxSize: 10,
    ...extra,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.class as { id: string };
}

beforeAll(async () => {
  const base = await createTestApp();
  ctx = { ...base, admin: await bootstrapAdmin(base.app) };
});

describe('danh mục và cài đặt', () => {
  it('46 gói được nạp; mọi nhân sự đăng nhập đều đọc được, chỉ Admin/Manager sửa được', async () => {
    const teacher = await actor('teacher', 'gv-danhmuc@we.vn');
    const list = await teacher.client.get('/api/v1/programs');
    expect(list.status).toBe(200);
    expect(list.body.programs).toHaveLength(46);
    expect(list.body.programs.find((p: { id: string }) => p.id === 'baby-stars')).toMatchObject({ tuition: 6_000_000, sessionsCount: 36 });

    expect((await teacher.client.patch('/api/v1/programs/baby-stars', { tuition: 1 })).status).toBe(403);
    const ok = await ctx.admin.patch('/api/v1/programs/baby-stars', { tuition: 6_200_000 });
    expect(ok.status).toBe(200);
    expect(ok.body.program.tuition).toBe(6_200_000);
    await ctx.admin.patch('/api/v1/programs/baby-stars', { tuition: 6_000_000 });
  });

  it('chưa đăng nhập không đọc được danh mục', async () => {
    expect((await new Client(ctx.app).get('/api/v1/programs')).status).toBe(401);
  });

  it('cài đặt mặc định; Manager sửa được; ngưỡng Redflag phải thấp hơn Good', async () => {
    const manager = await actor('manager', 'ql-caidat@we.vn');
    const got = await manager.client.get('/api/v1/settings');
    expect(got.body.settings).toEqual({ reminderDays: 30, teacherEditDays: 3, redflagBelow: 60, goodAbove: 80 });

    const changed = await manager.client.req('PUT', '/api/v1/settings', { teacherEditDays: 5 });
    expect(changed.status).toBe(200);
    expect(changed.body.settings.teacherEditDays).toBe(5);
    await manager.client.req('PUT', '/api/v1/settings', { teacherEditDays: 3 });

    const bad = await manager.client.req('PUT', '/api/v1/settings', { redflagBelow: 90 });
    expect(bad.status).toBe(400);
    const teacher = await actor('teacher', 'gv-caidat@we.vn');
    expect((await teacher.client.req('PUT', '/api/v1/settings', { reminderDays: 20 })).status).toBe(403);
  });

  it('ca học và phòng', async () => {
    const res = await ctx.admin.get('/api/v1/reference');
    expect(res.body.slots.map((s: { id: string }) => s.id)).toEqual(['chieu', 'toi1', 'toi2', 't7a', 't7b']);
    expect(res.body.rooms).toHaveLength(7);
  });
});

describe('học viên', () => {
  it('mã học viên tăng dần, trùng tên vẫn có mã riêng, không tự gộp', async () => {
    const a = await newStudent('Nguyễn Văn Trùng');
    const b = await newStudent('Nguyễn Văn Trùng');
    expect(a.code).toMatch(/^HV\d{4}$/);
    expect(b.code).not.toBe(a.code);
    expect(b.id).not.toBe(a.id);
  });

  it('kiểm tra dữ liệu: ngày sinh tương lai, số điện thoại sai', async () => {
    const future = await ctx.admin.post('/api/v1/students', { name: 'X', birthday: '2030-01-01' });
    expect(future.status).toBe(400);
    expect(future.body.error.fields.birthday).toBeDefined();
    const phone = await ctx.admin.post('/api/v1/students', { name: 'X', birthday: '2018-01-01', phone: '123' });
    expect(phone.status).toBe(400);
    expect(phone.body.error.fields.phone).toBeDefined();
  });

  it('liên hệ và học phí chỉ Admin/Manager thấy; giáo viên chỉ thấy học viên của lớp mình', async () => {
    const teacher = await actor('teacher', 'gv-hv@we.vn');
    const inspector = await actor('inspector', 'tt-hv@we.vn');
    const mine = await newStudent('Học viên của GV');
    const other = await newStudent('Học viên lớp khác');
    const myClass = await newClass(teacher.id);
    const otherClass = await newClass(null);
    for (const [s, c] of [[mine, myClass], [other, otherClass]] as const) {
      const r = await ctx.admin.post('/api/v1/enrollments', { studentId: s.id, programId: 'smart-explorers-1', classId: c.id, startDate: '2026-10-05' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    }

    const adminList = await ctx.admin.get('/api/v1/students');
    expect(adminList.body.students.find((s: { id: string }) => s.id === mine.id).phone).toBe('0912345678');

    const teacherList = await teacher.client.get('/api/v1/students');
    expect(teacherList.body.students.map((s: { id: string }) => s.id)).toEqual([mine.id]);
    expect(teacherList.body.students[0].phone).toBeUndefined();
    expect(teacherList.body.students[0].guardian).toBeUndefined();

    expect((await teacher.client.get(`/api/v1/students/${mine.id}`)).status).toBe(200);
    expect((await teacher.client.get(`/api/v1/students/${other.id}`)).status).toBe(403);

    const inspectorList = await inspector.client.get('/api/v1/students');
    expect(inspectorList.body.students.length).toBeGreaterThanOrEqual(2);
    expect(inspectorList.body.students[0].phone).toBeUndefined();

    expect((await teacher.client.post('/api/v1/students', { name: 'X', birthday: '2018-01-01' })).status).toBe(403);
  });

  it('dấu sao: cần ngưỡng hợp lệ; Thanh tra được đặt, giáo viên không', async () => {
    const inspector = await actor('inspector', 'tt-sao@we.vn');
    const teacher = await actor('teacher', 'gv-sao@we.vn');
    const s = await newStudent('Bé có dấu sao');

    const bad = await inspector.client.patch(`/api/v1/students/${s.id}/star`, { star: true, redflagBelow: 80, goodAbove: 70 });
    expect(bad.status).toBe(400);
    const ok = await inspector.client.patch(`/api/v1/students/${s.id}/star`, { star: true, redflagBelow: 50, goodAbove: 75 });
    expect(ok.status).toBe(200);
    expect(ok.body.student).toMatchObject({ star: true, redflagBelow: 50, goodAbove: 75 });
    expect((await teacher.client.patch(`/api/v1/students/${s.id}/star`, { star: false })).status).toBe(403);

    const off = await ctx.admin.patch(`/api/v1/students/${s.id}/star`, { star: false });
    expect(off.body.student).toMatchObject({ star: false, redflagBelow: null, goodAbove: null });
  });
});

describe('lớp học', () => {
  it('tạo lớp: ca/phòng không tồn tại → 400; giáo viên phải có vai trò Giáo viên', async () => {
    const teacher = await actor('teacher', 'gv-lop@we.vn');
    const inspector = await actor('inspector', 'tt-lop@we.vn');
    const base = { name: 'Lớp kiểm tra', slotId: 'toi1', room: '101', weekdays: [1, 3, 5] };

    expect((await ctx.admin.post('/api/v1/classes', { ...base, slotId: 'khong-co' })).status).toBe(400);
    expect((await ctx.admin.post('/api/v1/classes', { ...base, room: '999' })).status).toBe(400);
    expect((await ctx.admin.post('/api/v1/classes', { ...base, teacherId: inspector.id })).status).toBe(400);
    expect((await ctx.admin.post('/api/v1/classes', { ...base, weekdays: [] })).status).toBe(400);
    expect((await ctx.admin.post('/api/v1/classes', { ...base, teacherId: teacher.id })).status).toBe(201);
    expect((await teacher.client.post('/api/v1/classes', base)).status).toBe(403);
  });

  it('giáo viên chỉ thấy và mở lớp được phân công', async () => {
    const teacher = await actor('teacher', 'gv-lop2@we.vn');
    const mine = await newClass(teacher.id);
    const theirs = await newClass(null);

    const list = await teacher.client.get('/api/v1/classes');
    expect(list.body.classes.map((c: { id: string }) => c.id)).toEqual([mine.id]);
    expect((await teacher.client.get(`/api/v1/classes/${mine.id}`)).status).toBe(200);
    expect((await teacher.client.get(`/api/v1/classes/${theirs.id}`)).status).toBe(403);
    expect((await ctx.admin.get('/api/v1/classes')).body.classes.length).toBeGreaterThan(1);
  });
});

describe('khóa đăng ký và lịch buổi học (NT01)', () => {
  it('NT01: một hồ sơ, hai khóa khác nhau có tiến độ, học phí, định mức bù và lịch riêng', async () => {
    const s = await newStudent('Học viên hai khóa');
    const c246 = await newClass(null, { weekdays: [1, 3, 5] });
    const c357 = await newClass(null, { weekdays: [2, 4, 6] });

    const e1 = await ctx.admin.post('/api/v1/enrollments', { studentId: s.id, programId: 'baby-stars', classId: c246.id, startDate: '2026-09-07' });
    const e2 = await ctx.admin.post('/api/v1/enrollments', { studentId: s.id, programId: 'ielts-we102', classId: c357.id, startDate: '2026-09-08', tuition: 8_000_000 });
    expect(e1.status, JSON.stringify(e1.body)).toBe(201);
    expect(e2.status, JSON.stringify(e2.body)).toBe(201);

    const profile = await ctx.admin.get(`/api/v1/students/${s.id}`);
    const [a, b] = profile.body.enrollments;
    expect(profile.body.student.code).toBe(s.code);
    expect(profile.body.enrollments).toHaveLength(2);

    expect(a).toMatchObject({ totalSessions: 36, tuition: 6_000_000, makeupQuota: { maxCount: 5, minutes: 30 }, weekdays: [1, 3, 5] });
    expect(b).toMatchObject({ totalSessions: 36, tuition: 8_000_000, makeupQuota: { maxCount: 2, minutes: 90 }, weekdays: [2, 4, 6] });
    expect(a.progress.total).toBe(36);
    expect(a.progress.endDate).not.toBe(b.progress.endDate);
    expect(a.progress.held).toBeGreaterThan(0);
    expect(a.progress.held + a.progress.remaining).toBe(36);

    const rows = await ctx.db.query<{ date: string; seq: number }>(
      'SELECT date::text AS date, seq FROM course_sessions WHERE enrollment_id = $1 ORDER BY seq',
      [a.id],
    );
    expect(rows.rows).toHaveLength(36);
    expect(rows.rows.every((r) => [1, 3, 5].includes(weekdayOf(r.date)))).toBe(true);
    expect(rows.rows[0].date).toBe('2026-09-07');
  });

  it('đổi giá trong danh mục không ghi đè khóa đã đăng ký', async () => {
    const s = await newStudent();
    const c = await newClass(null);
    const e = await ctx.admin.post('/api/v1/enrollments', { studentId: s.id, programId: 'starters-nen-tang', classId: c.id, startDate: '2026-10-05' });
    expect(e.body.enrollment.tuition).toBe(9_300_000);

    await ctx.admin.patch('/api/v1/programs/starters-nen-tang', { tuition: 9_999_000 });
    const after = await ctx.admin.get('/api/v1/enrollments');
    expect(after.body.enrollments.find((x: { id: string }) => x.id === e.body.enrollment.id).tuition).toBe(9_300_000);
    await ctx.admin.patch('/api/v1/programs/starters-nen-tang', { tuition: 9_300_000 });
  });

  it('gói tính theo tháng cần Admin xác nhận số buổi; nhập số buổi thì đăng ký được và chưa có định mức bù', async () => {
    const s = await newStudent();
    const c = await newClass(null);
    const base = { studentId: s.id, programId: 'lop10-gd1', classId: c.id, startDate: '2026-10-05' };

    const missing = await ctx.admin.post('/api/v1/enrollments', base);
    expect(missing.status).toBe(422);
    expect(missing.body.error.code).toBe('SESSIONS_REQUIRED');

    const ok = await ctx.admin.post('/api/v1/enrollments', { ...base, totalSessions: 54 });
    expect(ok.status).toBe(201);
    expect(ok.body.enrollment.totalSessions).toBe(54);
    expect(ok.body.enrollment.makeupQuota).toBeNull();
  });

  it('lớp đủ sĩ số, học viên đã nghỉ, lớp chưa có ngày học đều bị chặn ở server', async () => {
    const tiny = await newClass(null, { maxSize: 1 });
    const a = await newStudent();
    const b = await newStudent();
    const base = { programId: 'smart-learners-1', classId: tiny.id, startDate: '2026-10-05' };
    expect((await ctx.admin.post('/api/v1/enrollments', { ...base, studentId: a.id })).status).toBe(201);
    const full = await ctx.admin.post('/api/v1/enrollments', { ...base, studentId: b.id });
    expect(full.status).toBe(422);
    expect(full.body.error.code).toBe('CLASS_FULL');

    const left = await newStudent();
    await ctx.admin.patch(`/api/v1/students/${left.id}`, { status: 'left' });
    const roomy = await newClass(null);
    const gone = await ctx.admin.post('/api/v1/enrollments', { ...base, classId: roomy.id, studentId: left.id });
    expect(gone.body.error.code).toBe('STUDENT_LEFT');

    const noDays = await ctx.db.query<{ id: string }>(
      "INSERT INTO classes (name, slot_id, room) VALUES ('Lớp không ngày', 'toi1', '101') RETURNING id::text AS id",
    );
    const nd = await ctx.admin.post('/api/v1/enrollments', { ...base, classId: noDays.rows[0].id, studentId: b.id });
    expect(nd.body.error.code).toBe('NO_WEEKDAYS');
  });

  it('chỉ Admin/Manager xem và tạo khóa; giáo viên bị từ chối ở API', async () => {
    const teacher = await actor('teacher', 'gv-khoa@we.vn');
    expect((await teacher.client.get('/api/v1/enrollments')).status).toBe(403);
    expect((await teacher.client.post('/api/v1/enrollments', {})).status).toBe(403);
  });

  it('dữ liệu sai bị báo lỗi theo trường, không lưu dở', async () => {
    const before = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM enrollments');
    const res = await ctx.admin.post('/api/v1/enrollments', { studentId: 'abc', programId: '', classId: '1', startDate: '2026-13-45' });
    expect(res.status).toBe(400);
    expect(Object.keys(res.body.error.fields).sort()).toEqual(['programId', 'startDate', 'studentId']);
    const after = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM enrollments');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});

describe('ngày nghỉ trung tâm dời lịch (NT08, phần lịch)', () => {
  it('thêm ngày nghỉ: định mức vẫn đủ, ngày kết thúc dời, buổi trước đó giữ nguyên; xóa thì khôi phục', async () => {
    const s = await newStudent();
    const c = await newClass(null);
    const created = await ctx.admin.post('/api/v1/enrollments', { studentId: s.id, programId: 'ielts-we101', classId: c.id, startDate: '2026-10-26' });
    const id = created.body.enrollment.id as string;
    const sessions = async () =>
      (await ctx.db.query<{ date: string }>('SELECT date::text AS date FROM course_sessions WHERE enrollment_id = $1 ORDER BY seq', [id])).rows.map((r) => r.date);

    const before = await sessions();
    expect(before).toHaveLength(36);
    const holiday = before[5];

    const added = await ctx.admin.post('/api/v1/holidays', { date: holiday, reason: 'Thử nghiệm nghỉ lễ' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.holiday.rescheduledEnrollments).toBeGreaterThanOrEqual(1);

    const after = await sessions();
    expect(after).toHaveLength(36);
    expect(after).not.toContain(holiday);
    expect(after.slice(0, 5)).toEqual(before.slice(0, 5));
    expect(after[35] > before[35]).toBe(true);
    expect(new Set(after).size).toBe(36);

    expect((await ctx.admin.post('/api/v1/holidays', { date: holiday, reason: 'Trùng' })).status).toBe(409);

    const removed = await ctx.admin.req('DELETE', `/api/v1/holidays/${holiday}`);
    expect(removed.status).toBe(200);
    expect(await sessions()).toEqual(before);
  });

  it('ngày nghỉ đã qua (chưa có điểm danh) vẫn ghi nhận được; định dạng sai và người không có quyền bị chặn', async () => {
    const teacher = await actor('teacher', 'gv-nghi@we.vn');
    const past = await ctx.admin.post('/api/v1/holidays', { date: '2026-01-01', reason: 'Tết dương lịch (đã qua)' });
    expect(past.status).toBe(201);
    expect((await ctx.admin.req('DELETE', '/api/v1/holidays/2026-01-01')).status).toBe(200);

    expect((await ctx.admin.post('/api/v1/holidays', { date: '2026/12/25', reason: 'Sai định dạng' })).status).toBe(400);
    expect((await teacher.client.post('/api/v1/holidays', { date: '2026-12-25', reason: 'Lễ' })).status).toBe(403);
    expect((await teacher.client.get('/api/v1/holidays')).status).toBe(200);
    expect(TEST_TODAY).toBe('2026-10-22');
  });
});
