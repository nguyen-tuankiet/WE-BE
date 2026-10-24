import { beforeAll, describe, expect, it } from 'vitest';
import { summarize, validateUnitValues } from '../src/domain/grading.js';
import { Client, bootstrapAdmin, createTestApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof createTestApp>> & { admin: Client };
let ctx: Ctx;
let seq = 0;

async function actor(role: 'manager' | 'teacher' | 'inspector', email: string) {
  const created = await ctx.admin.post('/api/v1/staff', { email, name: `${role} ${email}`, pin: '123456', roles: [role] });
  expect(created.status).toBe(201);
  const c = new Client(ctx.app);
  expect((await c.post('/api/v1/auth/login', { email, pin: '123456' })).status).toBe(200);
  return c;
}

async function addUnits(template: 'baby' | 'foundation' | 'cambridge', count = 2) {
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const r = await ctx.admin.post('/api/v1/academics/units', { template, name: `Unit ${i}`, topic: `Chủ đề ${template} ${i}`, words: ['a', 'b', 'c', 'd'], patterns: ['It is …'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    ids.push(r.body.unit.id);
  }
  return ids;
}

async function enroll(programId: string, extra: { star?: [number, number] } = {}) {
  const cls = await ctx.admin.post('/api/v1/classes', { name: `Lớp KT ${++seq}`, slotId: 'toi1', room: '101', weekdays: [1, 3, 5] });
  const s = await ctx.admin.post('/api/v1/students', { name: `HV KT ${seq}`, birthday: '2018-01-01' });
  const studentId = s.body.student.id as string;
  const e = await ctx.admin.post('/api/v1/enrollments', { studentId, programId, classId: cls.body.class.id, startDate: '2026-10-05' });
  expect(e.status, JSON.stringify(e.body)).toBe(201);
  if (extra.star) await ctx.admin.patch(`/api/v1/students/${studentId}/star`, { star: true, redflagBelow: extra.star[0], goodAbove: extra.star[1] });
  return { enrollmentId: e.body.enrollment.id as string, studentId };
}

const cambridgeValues = (score: number, extra: Record<string, unknown> = {}) => ({ pattern: score, freestyle: score, pron1: 'clear', pron2: 'clear', gram1: 'ok', gram2: 'ok', ...extra });
const plan = (enrollmentId: string, unitIds: string[], plannedDate = '2026-10-24') => ctx.admin.post('/api/v1/exams/plans', { enrollmentId, plannedDate, unitIds });
const grade = (c: Client, planId: string, unitIds: string[], values: Record<string, unknown>[], extra: Record<string, unknown> = {}) =>
  c.req('PUT', `/api/v1/exams/plans/${planId}/result`, { units: unitIds.map((unitId, i) => ({ unitId, values: values[i] ?? values[0] })), comment: 'Nhận xét', support: 'Hỗ trợ', ...extra });

let cambridge: string[];
let foundation: string[];

beforeAll(async () => {
  const base = await createTestApp();
  ctx = { ...base, admin: await bootstrapAdmin(base.app) };
  cambridge = await addUnits('cambridge');
  foundation = await addUnits('foundation');
});

describe('chấm điểm (domain)', () => {
  it('có tiêu chí Redflag thì kết quả chung là Redflag dù điểm trung bình cao; ngưỡng riêng đổi phân loại nhưng giữ điểm gốc', () => {
    const t = { redflagBelow: 60, goodAbove: 80 };
    const r = summarize('baby', [{ values: { spelling: 100, writing: 50 } }], t);
    expect(r.overall).toBe('redflag');
    expect(r.percent).toBe(75);
    const star = summarize('baby', [{ values: { spelling: 55, writing: 55 } }], { redflagBelow: 40, goodAbove: 70 });
    expect(star.overall).toBe('average');
    expect(star.percent).toBe(55);
  });

  it('kiểm tra giá trị Unit: thiếu trường, ngoài 0–100, lựa chọn sai, tiêu chí lạ', () => {
    expect(validateUnitValues('baby', { spelling: 80 })).toEqual({ writing: 'Thiếu trường bắt buộc.' });
    expect(validateUnitValues('baby', { spelling: 101, writing: -1 })).toEqual({ spelling: 'Điểm phải từ 0 đến 100.', writing: 'Điểm phải từ 0 đến 100.' });
    expect(Object.keys(validateUnitValues('foundation', { vocabulary: 50, communication: 50, pronunciation: 'maybe' }))).toEqual(['pronunciation']);
    expect(validateUnitValues('baby', { spelling: 1, writing: 1, bonus: 5 })).toEqual({ bonus: 'Tiêu chí không thuộc mẫu phiếu này.' });
  });
});

describe('khung nội dung', () => {
  it('Admin/Manager/Thanh tra tạo và sửa Unit; giáo viên bị từ chối ở server', async () => {
    const inspector = await actor('inspector', 'tt-khung@we.vn');
    const teacher = await actor('teacher', 'gv-khung@we.vn');
    const made = await inspector.post('/api/v1/academics/units', { template: 'baby', name: 'Unit 1', topic: 'Hello', words: ['hello'], patterns: [] });
    expect(made.status).toBe(201);
    expect(made.body.unit.id).toBe('baby-u1');
    const edited = await inspector.patch(`/api/v1/academics/units/${made.body.unit.id}`, { topic: 'Hello & Colors', words: ['hello', 'red'] });
    expect(edited.body.unit).toMatchObject({ topic: 'Hello & Colors', words: ['hello', 'red'] });
    const list = await ctx.admin.get('/api/v1/academics/units?template=baby');
    expect(list.body.units.map((u: { id: string }) => u.id)).toEqual(['baby-u1']);

    expect((await teacher.get('/api/v1/academics/units')).status).toBe(403);
    expect((await teacher.post('/api/v1/academics/units', { template: 'baby', name: 'X' })).status).toBe(403);
    expect((await ctx.admin.post('/api/v1/academics/units', { template: 'khong-co', name: 'X' })).status).toBe(400);
  });
});

describe('lịch kiểm tra và chấm nhiều Unit (NT11)', () => {
  it('không lên lịch cho chương trình chưa có mẫu chấm; Unit sai khung hoặc rỗng bị chặn', async () => {
    const noTemplate = await enroll('ielts-we101');
    const none = await plan(noTemplate.enrollmentId, cambridge);
    expect(none.status).toBe(422);
    expect(none.body.error.code).toBe('NO_EXAM_CONTENT');

    const e = await enroll('starters-nen-tang');
    const wrong = await plan(e.enrollmentId, foundation);
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields.unitIds).toBeDefined();
    expect((await plan(e.enrollmentId, [])).status).toBe(400);
    expect((await plan(e.enrollmentId, ['cam-u999'])).status).toBe(400);
  });

  it('NT11: lên lịch 2 Unit, chấm đủ → hoàn tất; lịch và kết quả cập nhật cùng nhau, liên kết đủ 2 Unit', async () => {
    const e = await enroll('starters-nen-tang');
    const created = await plan(e.enrollmentId, cambridge);
    expect(created.status).toBe(201);
    const planId = created.body.plan.id as string;
    expect(created.body.plan.units.map((u: { id: string }) => u.id)).toEqual(cambridge);

    const res = await grade(ctx.admin, planId, cambridge, [cambridgeValues(85)]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.result).toMatchObject({ overall: 'good', percent: 85, planId, examiner: 'Quản trị' });
    expect(res.body.result.units.map((u: { unitId: string }) => u.unitId)).toEqual(cambridge);

    const exams = await ctx.admin.get('/api/v1/exams');
    expect(exams.body.plans.find((p: { id: string }) => p.id === planId).status).toBe('done');
    expect(exams.body.results.filter((r: { planId: string }) => r.planId === planId)).toHaveLength(1);
  });

  it('thiếu trường, thiếu Unit hay điểm sai → 400 theo trường và KHÔNG lưu dở (lịch vẫn chờ chấm)', async () => {
    const e = await enroll('starters-nen-tang');
    const planId = (await plan(e.enrollmentId, cambridge)).body.plan.id as string;

    const missing = await grade(ctx.admin, planId, cambridge, [cambridgeValues(80), { pattern: 80 }]);
    expect(missing.status).toBe(400);
    expect(Object.keys(missing.body.error.fields)).toContain('units.1.freestyle');

    const range = await grade(ctx.admin, planId, cambridge, [cambridgeValues(120)]);
    expect(range.status).toBe(400);
    expect(range.body.error.fields['units.0.pattern']).toBeDefined();

    const choice = await grade(ctx.admin, planId, cambridge, [cambridgeValues(80, { pron1: 'maybe' })]);
    expect(choice.body.error.fields['units.0.pron1']).toBeDefined();

    const onlyOne = await ctx.admin.req('PUT', `/api/v1/exams/plans/${planId}/result`, { units: [{ unitId: cambridge[0], values: cambridgeValues(80) }] });
    expect(onlyOne.status).toBe(400);
    expect(onlyOne.body.error.fields.units).toBeDefined();

    const status = await ctx.admin.get(`/api/v1/exams/plans/${planId}`);
    expect(status.body.plan.status).toBe('pending');
    expect(status.body.result).toBeNull();
    const n = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM exam_results WHERE plan_id = $1', [planId]);
    expect(n.rows[0].n).toBe(0);
  });

  it('lưu lại không tạo kết quả trùng: cập nhật kết quả cũ', async () => {
    const e = await enroll('starters-nen-tang');
    const planId = (await plan(e.enrollmentId, cambridge)).body.plan.id as string;
    await grade(ctx.admin, planId, cambridge, [cambridgeValues(70)]);
    const again = await grade(ctx.admin, planId, cambridge, [cambridgeValues(90)], { comment: 'Chấm lại' });
    expect(again.body.result).toMatchObject({ overall: 'good', percent: 90, comment: 'Chấm lại' });
    const n = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM exam_results WHERE plan_id = $1', [planId]);
    expect(n.rows[0].n).toBe(1);
    const units = await ctx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM exam_result_units er JOIN exam_results r ON r.id = er.result_id WHERE r.plan_id = $1', [planId]);
    expect(units.rows[0].n).toBe(2);
  });

  it('phân loại: Redflag khi một tiêu chí dưới 60%, Good khi trên 80%, còn lại Average', async () => {
    const mk = async (pattern: number, freestyle: number) => {
      const e = await enroll('movers-nen-tang');
      const planId = (await plan(e.enrollmentId, [cambridge[0]])).body.plan.id as string;
      return (await grade(ctx.admin, planId, [cambridge[0]], [cambridgeValues(0, { pattern, freestyle })])).body.result;
    };
    expect((await mk(100, 50)).overall).toBe('redflag');
    expect((await mk(85, 85)).overall).toBe('good');
    expect((await mk(70, 75)).overall).toBe('average');
  });

  it('Foundation: Vocabulary là phần trăm số từ đạt, Pronunciation báo cáo riêng không tính điểm tổng', async () => {
    const e = await enroll('smart-explorers-1');
    const planId = (await plan(e.enrollmentId, [foundation[0]])).body.plan.id as string;
    const res = await grade(ctx.admin, planId, [foundation[0]], [{ vocabulary: 62.5, communication: 70, pronunciation: 'unclear' }]);
    expect(res.body.result.percent).toBe(66.25);
    expect(res.body.result.criteria.map((c: { key: string }) => c.key)).toEqual(['vocabulary', 'communication']);
    expect(res.body.result.units[0].values.pronunciation).toBe('unclear');
  });

  it('chỉ Admin/Manager/Thanh tra chấm và xem; giáo viên bị từ chối ở API', async () => {
    const teacher = await actor('teacher', 'gv-cham@we.vn');
    const manager = await actor('manager', 'ql-cham@we.vn');
    const e = await enroll('starters-luyen-de');
    const planId = (await plan(e.enrollmentId, cambridge)).body.plan.id as string;
    expect((await teacher.get('/api/v1/exams')).status).toBe(403);
    expect((await teacher.get(`/api/v1/exams/plans/${planId}`)).status).toBe(403);
    expect((await grade(teacher, planId, cambridge, [cambridgeValues(80)])).status).toBe(403);
    expect((await teacher.get('/api/v1/reports/students')).status).toBe(403);
    expect((await manager.get('/api/v1/exams')).status).toBe(200);
  });
});

describe('ngưỡng và nội dung đã dùng (NT13, NT14)', () => {
  it('NT13: dấu sao đổi phân loại nhưng giữ điểm gốc; đặt sao SAU khi chấm không đổi kết quả đã lưu', async () => {
    const starred = await enroll('starters-nen-tang', { star: [40, 70] });
    const normal = await enroll('starters-nen-tang');
    const gradeBoth = async (e: { enrollmentId: string }) => {
      const planId = (await plan(e.enrollmentId, [cambridge[0]])).body.plan.id as string;
      return { planId, result: (await grade(ctx.admin, planId, [cambridge[0]], [cambridgeValues(55)])).body.result };
    };
    const a = await gradeBoth(starred);
    const b = await gradeBoth(normal);
    expect(a.result).toMatchObject({ overall: 'average', percent: 55, thresholds: { redflagBelow: 40, goodAbove: 70 } });
    expect(b.result).toMatchObject({ overall: 'redflag', percent: 55, thresholds: { redflagBelow: 60, goodAbove: 80 } });

    // Đặt sao cho học viên "normal" sau đó: kết quả đã chấm giữ nguyên phân loại và ngưỡng lúc chấm
    await ctx.admin.patch(`/api/v1/students/${normal.studentId}/star`, { star: true, redflagBelow: 40, goodAbove: 70 });
    const report = await ctx.admin.get(`/api/v1/reports/students/${normal.studentId}`);
    expect(report.body.thresholds).toEqual({ star: true, redflagBelow: 40, goodAbove: 70 });
    expect(report.body.results[0]).toMatchObject({ overall: 'redflag', percent: 55, thresholds: { redflagBelow: 60, goodAbove: 80 } });
    expect(report.body.results[0].criteria.every((c: { rating: string }) => c.rating === 'redflag')).toBe(true);

    // Lần kiểm tra MỚI sau khi đặt sao dùng ngưỡng riêng
    const next = await plan(normal.enrollmentId, [cambridge[1]]);
    const res = await grade(ctx.admin, next.body.plan.id, [cambridge[1]], [cambridgeValues(55)]);
    expect(res.body.result.overall).toBe('average');
  });

  it('NT14: sửa nội dung Unit sau khi chấm — báo cáo cũ vẫn cho thấy nội dung đã dùng', async () => {
    const [u] = await addUnits('baby', 1).then(() => ['baby-u2']); // baby-u1 đã có từ test khung, baby-u2 mới
    const e = await enroll('baby-stars');
    const planId = (await plan(e.enrollmentId, [u])).body.plan.id as string;
    await grade(ctx.admin, planId, [u], [{ spelling: 90, writing: 85 }]);

    await ctx.admin.patch(`/api/v1/academics/units/${u}`, { topic: 'Chủ đề ĐÃ SỬA', words: ['moi1', 'moi2'] });
    const report = await ctx.admin.get(`/api/v1/reports/students/${e.studentId}`);
    const used = report.body.results[0].snapshot[0];
    expect(used.topic).toBe('Chủ đề baby 1');
    expect(used.words).toEqual(['a', 'b', 'c', 'd']);
    expect(report.body.results[0].units[0]).toMatchObject({ name: 'Unit 1', topic: 'Chủ đề baby 1' });
    const current = await ctx.admin.get('/api/v1/academics/units?template=baby');
    expect(current.body.units.find((x: { id: string }) => x.id === u).topic).toBe('Chủ đề ĐÃ SỬA');

    // Chấm lại (sửa kết quả) vẫn giữ bản chụp ban đầu
    await grade(ctx.admin, planId, [u], [{ spelling: 95, writing: 95 }]);
    const after = await ctx.admin.get(`/api/v1/reports/students/${e.studentId}`);
    expect(after.body.results[0].snapshot[0].topic).toBe('Chủ đề baby 1');
  });
});

describe('báo cáo', () => {
  it('danh sách học viên có kết quả, báo cáo theo học viên, tóm tắt trong hồ sơ (Thanh tra thấy, giáo viên không)', async () => {
    const inspector = await actor('inspector', 'tt-bc@we.vn');
    const teacher = await actor('teacher', 'gv-bc@we.vn');
    const e = await enroll('flyers-nen-tang');
    const planId = (await plan(e.enrollmentId, cambridge)).body.plan.id as string;
    await grade(ctx.admin, planId, cambridge, [cambridgeValues(88)]);

    const students = await inspector.get('/api/v1/reports/students');
    expect(students.body.students.map((s: { id: string }) => s.id)).toContain(e.studentId);
    const report = await inspector.get(`/api/v1/reports/students/${e.studentId}`);
    expect(report.status).toBe(200);
    expect(report.body.results).toHaveLength(1);
    expect(report.body.results[0].criteria).toHaveLength(2);

    const profile = await inspector.get(`/api/v1/students/${e.studentId}`);
    expect(profile.body.exams).toEqual([expect.objectContaining({ overall: 'good', percent: 88 })]);
    expect((await ctx.admin.get(`/api/v1/students/${e.studentId}`)).body.exams).toHaveLength(1);
    expect((await teacher.get('/api/v1/reports/students/1')).status).toBe(403);
    expect((await ctx.admin.get('/api/v1/reports/students/999999')).status).toBe(404);
  });
});
