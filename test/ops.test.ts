import { beforeAll, describe, expect, it } from 'vitest';
import { csvToRows, parseCsv } from '../src/services/dataio.js';
import { Client, bootstrapAdmin, createTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestApp>> & { admin: Client };
let ctx: Ctx;
let seq = 0;
const TODAY = '2026-10-22';

async function actor(role: 'manager' | 'teacher' | 'inspector', email: string) {
  const created = await ctx.admin.post('/api/v1/staff', { email, name: `${role} ${email}`, pin: '123456', roles: [role] });
  expect(created.status).toBe(201);
  const c = new Client(ctx.app);
  expect((await c.post('/api/v1/auth/login', { email, pin: '123456' })).status).toBe(200);
  return { client: c, id: created.body.staff.id as string };
}

async function newClass(teacherId: string | null = null, weekdays = [1, 3, 5], extra: Record<string, unknown> = {}) {
  const r = await ctx.admin.post('/api/v1/classes', { name: `Lớp OPS ${++seq}`, slotId: 'toi1', room: '101', teacherId, weekdays, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.class.id as string;
}

async function enroll(opts: { classId: string; programId?: string; startDate?: string; totalSessions?: number; birthday?: string; tuitionReceived?: boolean }) {
  const s = await ctx.admin.post('/api/v1/students', { name: `HV OPS ${++seq}`, birthday: opts.birthday ?? '2018-01-01' });
  const e = await ctx.admin.post('/api/v1/enrollments', {
    studentId: s.body.student.id,
    programId: opts.programId ?? 'smart-explorers-1',
    classId: opts.classId,
    startDate: opts.startDate ?? '2026-10-05',
    ...(opts.totalSessions ? { totalSessions: opts.totalSessions } : {}),
    ...(opts.tuitionReceived !== undefined ? { tuitionReceived: opts.tuitionReceived } : {}),
  });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  return { id: e.body.enrollment.id as string, studentId: s.body.student.id as string };
}

const mark = (classId: string, enrollmentId: string, date: string, status: string, notified = false) =>
  ctx.admin.req('PUT', '/api/v1/attendance', { classId, date, items: [{ enrollmentId, status, notified }] });

beforeAll(async () => {
  const base = await createTestApp();
  ctx = { ...base, admin: await bootstrapAdmin(base.app) };
});

describe('CSV', () => {
  it('đọc dấu ngoặc kép, dấu phân cách và BOM; nhận tiêu đề tiếng Việt', () => {
    expect(parseCsv('﻿a,"b,c",d\r\n1,"x ""y""",3\r\n')).toEqual([
      ['a', 'b,c', 'd'],
      ['1', 'x "y"', '3'],
    ]);
    expect(parseCsv('a;b\n1;2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(csvToRows('Họ tên,Ngày sinh,SĐT\nNguyễn An,05/06/2015,0912345678')).toEqual([{ name: 'Nguyễn An', birthday: '05/06/2015', phone: '0912345678' }]);
  });
});

describe('Tổng quan', () => {
  it('buổi học theo khoảng ngày + điểm danh đã/ cần ghi nhận + thiếu điểm danh + học phí chưa nhận', async () => {
    const classId = await newClass();
    const a = await enroll({ classId, tuitionReceived: false });
    const b = await enroll({ classId, tuitionReceived: true });
    await mark(classId, a.id, '2026-10-21', 'present');
    await mark(classId, b.id, '2026-10-21', 'absent', true);

    // Ngày 10-21 (Thứ 4): 2 học viên trong lớp, đã ghi nhận đủ
    const day = await ctx.admin.get('/api/v1/dashboard?from=2026-10-21&to=2026-10-21');
    const sessions = day.body.sessions.filter((s: { class: { id: string } }) => s.class.id === classId);
    expect(sessions).toEqual([expect.objectContaining({ date: '2026-10-21', students: 2, recorded: 2 })]);
    expect(sessions[0].class).toMatchObject({ slotLabel: 'Tối 1', room: '101' });

    // Hôm nay (Thứ 5) lớp không học; ngày 10-23 là tương lai
    const today = await ctx.admin.get(`/api/v1/dashboard?from=${TODAY}&to=${TODAY}`);
    expect(today.body.sessions.filter((s: { class: { id: string } }) => s.class.id === classId)).toEqual([]);

    // Khoảng 10-19 → 10-23: 10-19 chưa ghi nhận (2 lượt), 10-21 đủ, 10-23 chưa tới
    const range = await ctx.admin.get('/api/v1/dashboard?from=2026-10-19&to=2026-10-23');
    const mine = range.body.sessions.filter((s: { class: { id: string } }) => s.class.id === classId);
    expect(mine.map((s: { date: string }) => s.date)).toEqual(['2026-10-19', '2026-10-21', '2026-10-23']);
    expect(range.body.unpaidCount).toBeGreaterThanOrEqual(1);
    expect(range.body.missingSessions).toBeGreaterThanOrEqual(2);
    expect(range.body.periodScheduled).toBeGreaterThanOrEqual(4);
    expect(range.body.periodRecorded).toBeGreaterThanOrEqual(2);
    expect(range.body.activeStudents).toBeGreaterThanOrEqual(2);
  });

  it('kiểm tra khoảng ngày; giáo viên chỉ thấy buổi lớp mình và không thấy chỉ số quản lý; Thanh tra không có buổi', async () => {
    const teacher = await actor('teacher', 'gv-db@we.vn');
    const inspector = await actor('inspector', 'tt-db@we.vn');
    const mine = await newClass(teacher.id);
    const other = await newClass(null);
    await enroll({ classId: mine });
    await enroll({ classId: other });

    expect((await ctx.admin.get('/api/v1/dashboard?from=2026-10-22&to=2026-10-01')).status).toBe(400);
    expect((await ctx.admin.get('/api/v1/dashboard?from=2026-01-01&to=2026-12-31')).status).toBe(400);
    expect((await ctx.admin.get('/api/v1/dashboard?from=abc')).status).toBe(400);

    const t = await teacher.client.get('/api/v1/dashboard?from=2026-10-19&to=2026-10-19');
    expect(t.status).toBe(200);
    expect(t.body.sessions.map((s: { class: { id: string } }) => s.class.id)).toEqual([mine]);
    expect(t.body.activeStudents).toBeNull();
    expect(t.body.unpaidCount).toBeNull();

    const i = await inspector.client.get('/api/v1/dashboard?from=2026-10-19&to=2026-10-19');
    expect(i.body.sessions).toEqual([]);
    expect((await new Client(ctx.app).get('/api/v1/dashboard')).status).toBe(401);
  });
});

describe('Biểu đồ và chi tiết', () => {
  it('xu hướng điểm danh, nhóm chương trình, khóa kết thúc theo tuần; bấm vào để xem danh sách', async () => {
    const classId = await newClass();
    const e = await enroll({ classId, totalSessions: 12 }); // 12 buổi từ 10-05 → kết thúc 10-30
    await mark(classId, e.id, '2026-10-14', 'absent', true);
    await mark(classId, e.id, '2026-10-16', 'late');

    const charts = await ctx.admin.get(`/api/v1/dashboard/charts?from=${TODAY}&to=${TODAY}`);
    expect(charts.status).toBe(200);
    const d14 = charts.body.attendanceTrend.find((r: { date: string }) => r.date === '2026-10-14');
    expect(d14).toMatchObject({ absent: expect.any(Number) });
    expect(d14.absent).toBeGreaterThanOrEqual(1);
    expect(charts.body.byGroup.find((g: { key: string }) => g.key === 'foundation').value).toBeGreaterThanOrEqual(1);
    expect(charts.body.endingByWeek).toHaveLength(8);
    const endWeek = charts.body.endingByWeek.find((w: { from: string; to: string }) => w.from <= '2026-10-30' && w.to >= '2026-10-30');
    expect(endWeek.from).toBe('2026-10-26');
    expect(endWeek.value).toBeGreaterThanOrEqual(1);

    const att = await ctx.admin.get('/api/v1/dashboard/detail/attendance?date=2026-10-14&status=absent');
    expect(att.body.rows.some((r: { studentId: string }) => r.studentId === e.studentId)).toBe(true);
    const grp = await ctx.admin.get('/api/v1/dashboard/detail/group?group=foundation');
    expect(grp.body.enrollments.some((x: { id: string }) => x.id === e.id)).toBe(true);
    const end = await ctx.admin.get('/api/v1/dashboard/detail/ending?from=2026-10-26&to=2026-11-01');
    expect(end.body.enrollments.some((x: { id: string }) => x.id === e.id)).toBe(true);
    expect((await ctx.admin.get('/api/v1/dashboard/detail/group?group=khong-co')).status).toBe(400);
    expect((await ctx.admin.get('/api/v1/dashboard/detail/attendance?date=2026-10-14&status=lol')).status).toBe(400);
  });

  it('phân quyền: giáo viên không có biểu đồ/chi tiết; Thanh tra chỉ có kết quả kiểm tra', async () => {
    const teacher = await actor('teacher', 'gv-bd@we.vn');
    const inspector = await actor('inspector', 'tt-bd@we.vn');
    const t = await teacher.client.get(`/api/v1/dashboard/charts?from=${TODAY}&to=${TODAY}`);
    expect(t.body).toEqual({ attendanceTrend: [], byGroup: [], endingByWeek: [], ratings: [] });
    const i = await inspector.client.get(`/api/v1/dashboard/charts?from=${TODAY}&to=${TODAY}`);
    expect(i.body.attendanceTrend).toEqual([]);
    expect(i.body.ratings).toHaveLength(3);
    expect((await teacher.client.get('/api/v1/dashboard/detail/group?group=foundation')).status).toBe(403);
    expect((await inspector.client.get('/api/v1/dashboard/detail/group?group=foundation')).status).toBe(403);
    expect((await inspector.client.get('/api/v1/dashboard/detail/rating?rating=good')).status).toBe(200);
    expect((await teacher.client.get('/api/v1/dashboard/detail/rating?rating=good')).status).toBe(403);
  });
});

describe('việc cần quan tâm', () => {
  it('sinh từ dữ liệu: sinh nhật, cuối khóa, thiếu điểm danh, học phí; đánh dấu đã xử lý lưu người + thời điểm và bỏ được', async () => {
    const classId = await newClass();
    const e = await enroll({ classId, totalSessions: 12, birthday: '2018-10-30', tuitionReceived: false });

    const list = (await ctx.admin.get('/api/v1/tasks')).body.tasks as { key: string; type: string; detail: string; handled: unknown }[];
    const keys = list.map((t) => t.key);
    expect(list.some((t) => t.key === `birthday:${e.studentId}:2026` && t.detail.includes('8 tuổi'))).toBe(true);
    expect(keys.filter((k) => k.startsWith(`end:${e.id}:`))).toHaveLength(1);
    expect(keys).toContain(`attn:${e.id}`);
    expect(keys).toContain(`tuition:${e.id}`);

    const key = `tuition:${e.id}`;
    expect((await ctx.admin.req('PUT', `/api/v1/tasks/${key}`, { done: true })).status).toBe(200);
    const after = (await ctx.admin.get('/api/v1/tasks')).body.tasks.find((t: { key: string }) => t.key === key);
    expect(after.handled).toMatchObject({ by: 'Quản trị' });
    expect(after.handled.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect((await ctx.admin.req('PUT', `/api/v1/tasks/${key}`, { done: false })).status).toBe(200);
    expect((await ctx.admin.get('/api/v1/tasks')).body.tasks.find((t: { key: string }) => t.key === key).handled).toBeNull();
    expect((await ctx.admin.req('PUT', '/api/v1/tasks/drop-table', { done: true })).status).toBe(400);
  });

  it('bảo lưu sắp hết hạn và kiểm tra chờ chấm; Thanh tra chỉ thấy việc kiểm tra; giáo viên không có', async () => {
    const inspector = await actor('inspector', 'tt-vl@we.vn');
    const teacher = await actor('teacher', 'gv-vl@we.vn');
    const classId = await newClass();
    const e = await enroll({ classId, programId: 'starters-nen-tang', startDate: '2026-10-05' });
    const unit = await ctx.admin.post('/api/v1/academics/units', { template: 'cambridge', name: 'Unit 1', topic: 'T', words: ['a'], patterns: [] });
    await ctx.admin.post('/api/v1/exams/plans', { enrollmentId: e.id, plannedDate: '2026-10-24', unitIds: [unit.body.unit.id] });
    const f = await enroll({ classId, startDate: '2026-07-01' });
    const r = await ctx.admin.post('/api/v1/reserves', { enrollmentId: f.id, noticeAt: '2026-08-10T09:00', completedOn: '2026-08-20', absentStreak: 10, amount: 0 });
    expect(r.status, JSON.stringify(r.body)).toBe(201); // hạn 2026-10-20 → đã quá hạn khi đọc

    const mgr = (await ctx.admin.get('/api/v1/tasks')).body.tasks as { type: string }[];
    expect(mgr.some((t) => t.type === 'exam')).toBe(true);
    const ins = (await inspector.client.get('/api/v1/tasks')).body.tasks as { type: string }[];
    expect(ins.length).toBeGreaterThan(0);
    expect(ins.every((t) => t.type === 'exam')).toBe(true);
    expect((await teacher.client.get('/api/v1/tasks')).body.tasks).toEqual([]);
    expect((await teacher.client.req('PUT', '/api/v1/tasks/tuition:1', { done: true })).status).toBe(403);
  });

  it('cửa sổ nhắc việc theo Cài đặt', async () => {
    await ctx.admin.req('PUT', '/api/v1/settings', { reminderDays: 7 });
    const classId = await newClass();
    const near = await enroll({ classId, birthday: '2018-10-25' });
    const far = await enroll({ classId, birthday: '2018-11-15' });
    const keys = (await ctx.admin.get('/api/v1/tasks')).body.tasks.map((t: { key: string }) => t.key);
    expect(keys).toContain(`birthday:${near.studentId}:2026`);
    expect(keys).not.toContain(`birthday:${far.studentId}:2026`);
    await ctx.admin.req('PUT', '/api/v1/settings', { reminderDays: 30 });
  });
});

describe('lịch CAP', () => {
  it('xếp lớp vào ô, xem ô kèm học viên, gỡ khỏi lịch; chặn trùng phòng, trùng giáo viên, lệch ngày học, ca sai nhóm', async () => {
    const teacher = await actor('teacher', 'gv-cap@we.vn');
    const c246 = await newClass(teacher.id, [1, 3, 5]);
    const other = await newClass(null, [1, 3, 5]);
    const c35 = await newClass(null, [2, 4, 6]);
    await enroll({ classId: c246 });
    const cap = (classId: string, group: string, slotId: string, room: string) => ctx.admin.post('/api/v1/cap', { classId, group, slotId, room });

    expect((await cap(c246, '2-4-6', 'toi1', '101')).status).toBe(201);
    const cells = (await ctx.admin.get('/api/v1/cap?group=2-4-6')).body.cells;
    const cell = cells.find((x: { room: string; slotId: string }) => x.room === '101' && x.slotId === 'toi1');
    expect(cell.class.id).toBe(c246);
    expect(cell.students).toHaveLength(1);

    const roomClash = await cap(other, '2-4-6', 'toi1', '101');
    expect(roomClash.status).toBe(409);
    expect(roomClash.body.error.code).toBe('CAP_ROOM_CONFLICT');
    expect((await cap(c246, '2-4-6', 'toi1', '102')).body.error.code).toBe('CAP_CLASS_DUPLICATE');
    const teacherClash = await ctx.admin.post('/api/v1/classes', { name: 'Lớp cùng GV', slotId: 'toi1', room: '102', teacherId: teacher.id, weekdays: [1, 3, 5] });
    expect((await cap(teacherClash.body.class.id, '2-4-6', 'toi1', '102')).body.error.code).toBe('CAP_TEACHER_CONFLICT');
    expect((await cap(c35, '2-4-6', 'toi2', '101')).body.error.code).toBe('CAP_DAYS_MISMATCH');
    expect((await cap(c246, '2-4-6', 't7a', '103')).body.error.code).toBe('CAP_SLOT_INVALID');
    expect((await cap(c246, '9-9', 'toi1', '103')).status).toBe(400);
    expect((await ctx.admin.get('/api/v1/cap?group=zzz')).status).toBe(400);

    expect((await ctx.admin.req('DELETE', '/api/v1/cap?group=2-4-6&slotId=toi1&room=101')).status).toBe(200);
    expect((await ctx.admin.get('/api/v1/cap?group=2-4-6')).body.cells.find((x: { room: string }) => x.room === '101')).toBeUndefined();
    expect((await ctx.admin.req('DELETE', '/api/v1/cap?group=2-4-6&slotId=toi1&room=101')).status).toBe(404);
    expect((await teacher.client.get('/api/v1/cap?group=2-4-6')).status).toBe(403);
    expect((await teacher.client.post('/api/v1/cap', { classId: c246, group: '2-4-6', slotId: 'toi1', room: '103' })).status).toBe(403);
  });
});

describe('nhập / xuất dữ liệu (NT17)', () => {
  it('nhập CSV qua đối chiếu: dòng lỗi được báo rõ, dòng hợp lệ vẫn lưu; chạy lặp không nhân đôi; trùng tên khác ngày sinh là học viên khác', async () => {
    const csv = [
      'Họ tên,Ngày sinh,Phụ huynh,SĐT,Địa chỉ',
      'Nguyễn Nhập A,05/06/2015,Chị Mai,0912345678,Thủ Đức',
      'Nguyễn Nhập B,2016-07-08,Anh Bình,,',
      ',01/01/2015,Thiếu tên,,',
      'Nguyễn Nhập C,31/02/2015,Sai ngày,,',
      'Nguyễn Nhập D,01/01/2015,Sai SĐT,12345,',
      'Nguyễn Nhập A,05/06/2015,Dòng lặp trong lô,,',
      'Nguyễn Nhập A,06/06/2016,Cùng tên khác ngày sinh,,',
    ].join('\n');

    const dry = await ctx.admin.post('/api/v1/import/students', { csv, dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, total: 7 });
    expect(dry.body.created).toEqual([]);
    const before = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM students');

    const first = await ctx.admin.post('/api/v1/import/students', { csv });
    expect(first.body.created.map((c: { name: string }) => c.name)).toEqual(['Nguyễn Nhập A', 'Nguyễn Nhập B', 'Nguyễn Nhập A']);
    expect(first.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4, 5]);
    expect(first.body.duplicates).toEqual([expect.objectContaining({ row: 6, existingCode: null })]);
    const codes = first.body.created.map((c: { code: string }) => c.code);
    expect(new Set(codes).size).toBe(3);
    const after = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM students');
    expect(after.rows[0].n).toBe(before.rows[0].n + 3);

    const again = await ctx.admin.post('/api/v1/import/students', { csv });
    expect(again.body.created).toEqual([]);
    expect(again.body.duplicates.map((d: { row: number }) => d.row).sort()).toEqual([1, 2, 6, 7]);
    expect(again.body.duplicates.find((d: { row: number }) => d.row === 1).existingCode).toBe(codes[0]);
    const final = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM students');
    expect(final.rows[0].n).toBe(after.rows[0].n);

    const profile = await ctx.admin.get(`/api/v1/students/${first.body.created[0].id}`);
    expect(profile.body.student).toMatchObject({ guardian: 'Chị Mai', phone: '0912345678', address: 'Thủ Đức', birthday: '2015-06-05' });
  });

  it('nhập bằng JSON, giới hạn dữ liệu, chỉ Admin/Manager; xuất CSV có BOM và đủ cột', async () => {
    const teacher = await actor('teacher', 'gv-io@we.vn');
    const res = await ctx.admin.post('/api/v1/import/students', { rows: [{ name: 'Học viên JSON', birthday: '2014-03-04', phone: '0987 654 321' }] });
    expect(res.body.created).toHaveLength(1);
    expect((await ctx.admin.post('/api/v1/import/students', {})).status).toBe(400);
    expect((await ctx.admin.post('/api/v1/import/students', { rows: [{ name: 'X', birthday: '2999-01-01' }] })).body.errors).toHaveLength(1);
    expect((await teacher.client.post('/api/v1/import/students', { rows: [] })).status).toBe(403);
    expect((await teacher.client.get('/api/v1/export/students.csv')).status).toBe(403);

    const out = await ctx.app.request('/api/v1/export/students.csv', { headers: { cookie: ctx.admin.cookie } });
    expect(out.status).toBe(200);
    expect(out.headers.get('content-type')).toContain('text/csv');
    const bytes = new Uint8Array(await out.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM để Excel đọc đúng tiếng Việt
    const text = await out.text();
    expect(text.split('\r\n')[0]).toContain('Họ tên');
    expect(text).toContain('Học viên JSON');
    expect(text).toContain('0987654321');
  });
});

describe('danh sách giáo viên để xếp lớp', () => {
  it('Admin/Manager thấy giáo viên đang hoạt động; giáo viên thì không', async () => {
    const teacher = await actor('teacher', 'gv-ds@we.vn');
    const manager = await actor('manager', 'ql-ds@we.vn');
    const res = await manager.client.get('/api/v1/teachers');
    expect(res.status).toBe(200);
    expect(res.body.teachers).toContainEqual({ id: teacher.id, name: 'teacher gv-ds@we.vn' });
    expect((await teacher.client.get('/api/v1/teachers')).status).toBe(403);
    await ctx.admin.req('PATCH', `/api/v1/staff/${teacher.id}`, { active: false });
    expect((await manager.client.get('/api/v1/teachers')).body.teachers.map((t: { id: string }) => t.id)).not.toContain(teacher.id);
  });
});

describe('giáo viên (trang quản lý)', () => {
  it('?all=1 trả cả người đã khóa kèm email; mặc định chỉ id + tên', async () => {
    const t = await actor('teacher', 'gv-all@we.vn');
    const manager = await actor('manager', 'ql-all@we.vn');
    await ctx.admin.req('PATCH', `/api/v1/staff/${t.id}`, { active: false });
    const all = (await manager.client.get('/api/v1/teachers?all=1')).body.teachers as { id: string; email: string; active: boolean }[];
    expect(all.find((x) => x.id === t.id)).toMatchObject({ email: 'gv-all@we.vn', active: false });
    const dflt = (await manager.client.get('/api/v1/teachers')).body.teachers as Record<string, unknown>[];
    expect(dflt.find((x) => x.id === t.id)).toBeUndefined();
    expect(Object.keys(dflt[0]).sort()).toEqual(['id', 'name']);
  });
});

describe('ngày sinh nhân sự', () => {
  it('nhập khi tạo, sửa, xóa; không cho ngày tương lai; trang giáo viên đọc được', async () => {
    const made = await ctx.admin.post('/api/v1/staff', { email: 'ns-sinh@we.vn', name: 'Có ngày sinh', pin: '123456', roles: ['teacher'], birthday: '1990-04-05' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(made.body.staff.birthday).toBe('1990-04-05');
    const id = made.body.staff.id as string;
    expect((await ctx.admin.req('PATCH', `/api/v1/staff/${id}`, { birthday: '1991-06-07' })).body.staff.birthday).toBe('1991-06-07');
    expect((await ctx.admin.req('PATCH', `/api/v1/staff/${id}`, { birthday: '2999-01-01' })).status).toBe(400);
    expect((await ctx.admin.post('/api/v1/staff', { email: 'ns-tl@we.vn', name: 'X', pin: '123456', roles: ['teacher'], birthday: '2999-01-01' })).status).toBe(400);

    const manager = await actor('manager', 'ql-sinh@we.vn');
    const list = (await manager.client.get('/api/v1/teachers?all=1')).body.teachers as { id: string; birthday: string | null }[];
    expect(list.find((t) => t.id === id)?.birthday).toBe('1991-06-07');
    expect((await ctx.admin.req('PATCH', `/api/v1/staff/${id}`, { birthday: null })).body.staff.birthday).toBeNull();
    expect((await ctx.admin.get('/api/v1/staff')).body.staff.find((s: { id: string }) => s.id === id).birthday).toBeNull();
  });
});
