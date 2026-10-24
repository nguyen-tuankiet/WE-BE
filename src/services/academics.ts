import type { Db, Queryable } from '../db/types.js';
import { summarize, validateUnitValues, type Rating, type Thresholds, type UnitTemplate, type UnitValues } from '../domain/grading.js';
import { AppError, errors } from '../errors.js';
import type { AuthUser } from '../types.js';
import { audit } from './audit.js';
import { getSettings } from './reference.js';

/* ---------- Khung nội dung (Unit) ---------- */

export interface UnitRow {
  id: string;
  template: UnitTemplate;
  name: string;
  topic: string;
  words: string[];
  patterns: string[];
  active: boolean;
  sortOrder: number;
}

const UNIT_SQL = `SELECT id, template, name, topic, words, patterns, active, sort_order AS "sortOrder" FROM curriculum_units`;
const ID_PREFIX: Record<UnitTemplate, string> = { baby: 'baby', foundation: 'found', cambridge: 'cam' };

export async function listUnits(q: Queryable, template?: UnitTemplate): Promise<UnitRow[]> {
  const res = await q.query<UnitRow>(`${UNIT_SQL} ${template ? 'WHERE template = $1' : ''} ORDER BY template, sort_order, id`, template ? [template] : []);
  return res.rows;
}

export interface UnitInput {
  template: UnitTemplate;
  name: string;
  topic: string;
  words: string[];
  patterns: string[];
}

export async function createUnit(db: Db, user: AuthUser, input: UnitInput): Promise<UnitRow> {
  return db.tx(async (q) => {
    const existing = await q.query<{ id: string; sort_order: number }>('SELECT id, sort_order FROM curriculum_units WHERE template = $1', [input.template]);
    const prefix = ID_PREFIX[input.template];
    let n = 0;
    for (const r of existing.rows) {
      const m = new RegExp(`^${prefix}-u(\\d+)$`).exec(r.id);
      if (m) n = Math.max(n, Number(m[1]));
    }
    const id = `${prefix}-u${n + 1}`;
    const order = existing.rows.reduce((mx, r) => Math.max(mx, r.sort_order), 0) + 1;
    await q.query(
      'INSERT INTO curriculum_units (id, template, name, topic, words, patterns, sort_order) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)',
      [id, input.template, input.name.trim(), input.topic.trim(), JSON.stringify(input.words), JSON.stringify(input.patterns), order],
    );
    await audit(q, { userId: user.id, entity: 'curriculum_unit', entityId: id, action: 'create', detail: { template: input.template, name: input.name } });
    return (await listUnits(q, input.template)).find((u) => u.id === id)!;
  });
}

export type UnitPatch = Partial<Pick<UnitInput, 'name' | 'topic' | 'words' | 'patterns'>> & { active?: boolean };

/** Sửa nội dung Unit. Không ảnh hưởng kết quả đã chấm (kết quả giữ bản chụp nội dung lúc chấm). */
export async function updateUnit(db: Db, user: AuthUser, id: string, patch: UnitPatch): Promise<UnitRow> {
  return db.tx(async (q) => {
    const cur = await q.query<{ template: UnitTemplate }>('SELECT template FROM curriculum_units WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) throw errors.notFound('Unit');
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.name !== undefined) add('name', patch.name.trim());
    if (patch.topic !== undefined) add('topic', patch.topic.trim());
    if (patch.words !== undefined) add('words', JSON.stringify(patch.words), '::jsonb');
    if (patch.patterns !== undefined) add('patterns', JSON.stringify(patch.patterns), '::jsonb');
    if (patch.active !== undefined) add('active', patch.active);
    if (sets.length > 0) await q.query(`UPDATE curriculum_units SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    await audit(q, { userId: user.id, entity: 'curriculum_unit', entityId: id, action: 'update', detail: { fields: Object.keys(patch) } });
    return (await listUnits(q, cur.rows[0].template)).find((u) => u.id === id)!;
  });
}

/* ---------- Lịch kiểm tra ---------- */

export interface PlanView {
  id: string;
  enrollmentId: string;
  plannedDate: string;
  status: 'pending' | 'done';
  student: { id: string; code: string; name: string };
  program: { id: string; name: string; template: UnitTemplate | null };
  units: { id: string; name: string; topic: string }[];
}

interface PlanDbRow {
  id: string;
  enrollment_id: string;
  planned_date: string;
  status: 'pending' | 'done';
  student_id: string;
  student_code: string;
  student_name: string;
  program_id: string;
  program_name: string;
  template: UnitTemplate | null;
}

const PLAN_SQL = `
  SELECT pl.id::text AS id, pl.enrollment_id::text AS enrollment_id, pl.planned_date::text AS planned_date, pl.status,
         s.id::text AS student_id, s.code AS student_code, s.name AS student_name,
         p.id AS program_id, p.name AS program_name, p.unit_template AS template
    FROM exam_plans pl
    JOIN enrollments e ON e.id = pl.enrollment_id
    JOIN students s ON s.id = e.student_id
    JOIN programs p ON p.id = e.program_id`;

async function planViews(q: Queryable, where = '', params: unknown[] = []): Promise<PlanView[]> {
  const plans = await q.query<PlanDbRow>(`${PLAN_SQL} ${where} ORDER BY pl.status DESC, pl.planned_date, pl.id`, params);
  if (plans.rowCount === 0) return [];
  const units = await q.query<{ plan_id: string; id: string; name: string; topic: string }>(
    `SELECT pu.plan_id::text AS plan_id, u.id, u.name, u.topic FROM exam_plan_units pu JOIN curriculum_units u ON u.id = pu.unit_id
      WHERE pu.plan_id = ANY($1::bigint[]) ORDER BY pu.sort_order`,
    [plans.rows.map((r) => r.id)],
  );
  return plans.rows.map((r) => ({
    id: r.id,
    enrollmentId: r.enrollment_id,
    plannedDate: r.planned_date,
    status: r.status,
    student: { id: r.student_id, code: r.student_code, name: r.student_name },
    program: { id: r.program_id, name: r.program_name, template: r.template },
    units: units.rows.filter((u) => u.plan_id === r.id).map(({ id, name, topic }) => ({ id, name, topic })),
  }));
}

export async function createPlan(db: Db, user: AuthUser, input: { enrollmentId: string; plannedDate: string; unitIds: string[] }): Promise<PlanView> {
  const unitIds = [...new Set(input.unitIds)];
  return db.tx(async (q) => {
    const enr = await q.query<{ status: string; template: UnitTemplate | null }>(
      'SELECT e.status, p.unit_template AS template FROM enrollments e JOIN programs p ON p.id = e.program_id WHERE e.id = $1',
      [input.enrollmentId],
    );
    if (enr.rowCount === 0) throw errors.notFound('Khóa đăng ký');
    if (enr.rows[0].status !== 'active') throw new AppError(422, 'ENROLLMENT_NOT_ACTIVE', 'Chỉ lên lịch kiểm tra cho khóa đang học.');
    const template = enr.rows[0].template;
    if (!template) {
      throw new AppError(422, 'NO_EXAM_CONTENT', 'Chương trình này chưa có nội dung/mẫu chấm, không thể lên lịch kiểm tra. Hệ thống không tự điền nội dung giả.');
    }
    const units = await q.query<{ id: string; sort_order: number }>(
      'SELECT id, sort_order FROM curriculum_units WHERE template = $1 AND active = true AND id = ANY($2::text[])',
      [template, unitIds],
    );
    if (units.rowCount !== unitIds.length) {
      throw errors.validation({ unitIds: 'Có Unit không tồn tại, đã ngừng dùng hoặc không thuộc khung của chương trình này.' });
    }
    const created = await q.query<{ id: string }>('INSERT INTO exam_plans (enrollment_id, planned_date, created_by) VALUES ($1, $2::date, $3) RETURNING id::text AS id', [
      input.enrollmentId,
      input.plannedDate,
      user.id,
    ]);
    const id = created.rows[0].id;
    const order = new Map(units.rows.map((u) => [u.id, u.sort_order]));
    const sorted = [...unitIds].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    for (const [i, unitId] of sorted.entries()) await q.query('INSERT INTO exam_plan_units (plan_id, unit_id, sort_order) VALUES ($1, $2, $3)', [id, unitId, i]);
    await audit(q, { userId: user.id, entity: 'exam_plan', entityId: id, action: 'create', detail: { enrollmentId: input.enrollmentId, unitIds: sorted } });
    return (await planViews(q, 'WHERE pl.id = $1', [id]))[0];
  });
}

/* ---------- Kết quả ---------- */

export interface ResultView {
  id: string;
  planId: string;
  enrollmentId: string;
  date: string;
  examiner: string;
  student: { id: string; code: string; name: string };
  program: { id: string; name: string };
  template: UnitTemplate;
  units: { unitId: string; name: string; topic: string; values: UnitValues }[];
  /** Nội dung Unit đã dùng, chụp tại thời điểm chấm */
  snapshot: { id: string; name: string; topic: string; words: string[]; patterns: string[] }[];
  comment: string;
  support: string;
  overall: Rating;
  percent: number;
  thresholds: Thresholds;
  criteria: { key: string; label: string; percent: number; rating: Rating }[];
}

interface ResultDbRow {
  id: string;
  plan_id: string;
  enrollment_id: string;
  date: string;
  examiner_name: string;
  student_id: string;
  student_code: string;
  student_name: string;
  program_id: string;
  program_name: string;
  template: UnitTemplate;
  comment: string;
  support: string;
  overall: Rating;
  percent: string;
  thresholds: Thresholds;
  snapshot: ResultView['snapshot'];
}

const RESULT_SQL = `
  SELECT r.id::text AS id, r.plan_id::text AS plan_id, r.enrollment_id::text AS enrollment_id, r.date::text AS date, r.examiner_name,
         s.id::text AS student_id, s.code AS student_code, s.name AS student_name, p.id AS program_id, p.name AS program_name,
         p.unit_template AS template, r.comment, r.support, r.overall, r.percent::text AS percent, r.thresholds, r.snapshot
    FROM exam_results r
    JOIN enrollments e ON e.id = r.enrollment_id
    JOIN students s ON s.id = e.student_id
    JOIN programs p ON p.id = e.program_id`;

async function resultViews(q: Queryable, where = '', params: unknown[] = []): Promise<ResultView[]> {
  const rows = await q.query<ResultDbRow>(`${RESULT_SQL} ${where} ORDER BY r.date DESC, r.id DESC`, params);
  if (rows.rowCount === 0) return [];
  const units = await q.query<{ result_id: string; unit_id: string; scores: UnitValues }>(
    'SELECT result_id::text AS result_id, unit_id, scores FROM exam_result_units WHERE result_id = ANY($1::bigint[])',
    [rows.rows.map((r) => r.id)],
  );
  return rows.rows.map((r) => {
    const mine = r.snapshot.map((u) => ({
      unitId: u.id,
      name: u.name,
      topic: u.topic,
      values: units.rows.find((x) => x.result_id === r.id && x.unit_id === u.id)?.scores ?? {},
    }));
    const summary = summarize(r.template, mine, r.thresholds);
    return {
      id: r.id,
      planId: r.plan_id,
      enrollmentId: r.enrollment_id,
      date: r.date,
      examiner: r.examiner_name,
      student: { id: r.student_id, code: r.student_code, name: r.student_name },
      program: { id: r.program_id, name: r.program_name },
      template: r.template,
      units: mine,
      snapshot: r.snapshot,
      comment: r.comment,
      support: r.support,
      overall: r.overall,
      percent: Number(r.percent),
      thresholds: r.thresholds,
      criteria: summary.perCriterion,
    };
  });
}

export async function listExams(db: Db): Promise<{ plans: PlanView[]; results: ResultView[] }> {
  return { plans: await planViews(db), results: await resultViews(db) };
}

export const listResultsByRating = (db: Db, rating: Rating) => resultViews(db, 'WHERE r.overall = $1', [rating]);

export async function getPlan(db: Db, id: string): Promise<{ plan: PlanView; units: UnitRow[]; result: ResultView | null }> {
  const plan = (await planViews(db, 'WHERE pl.id = $1', [id]))[0];
  if (!plan) throw errors.notFound('Lịch kiểm tra');
  const units = (await listUnits(db)).filter((u) => plan.units.some((p) => p.id === u.id)).sort((a, b) => plan.units.findIndex((p) => p.id === a.id) - plan.units.findIndex((p) => p.id === b.id));
  const result = (await resultViews(db, 'WHERE r.plan_id = $1', [id]))[0] ?? null;
  return { plan, units, result };
}

export interface ResultInput {
  units: { unitId: string; values: UnitValues }[];
  comment: string;
  support: string;
}

/**
 * Lưu kết quả và chuyển lịch sang Hoàn tất trong MỘT giao dịch (không lưu dở). Phải chấm đủ mọi Unit đã chọn và đủ trường bắt buộc.
 * Lưu lại không tạo kết quả trùng: cập nhật kết quả cũ, GIỮ nguyên bản chụp nội dung và ngưỡng của lần chấm đầu (docs/08 #5 chờ chốt).
 * Ngưỡng: dấu sao của học viên nếu có, ngược lại ngưỡng mặc định trong Cài đặt; điểm gốc luôn được giữ.
 */
export async function saveResult(db: Db, user: AuthUser, planId: string, input: ResultInput, today: string): Promise<ResultView> {
  return db.tx(async (q) => {
    const plan = await q.query<{ enrollment_id: string; template: UnitTemplate | null; student_id: string }>(
      `SELECT pl.enrollment_id::text AS enrollment_id, p.unit_template AS template, e.student_id::text AS student_id
         FROM exam_plans pl JOIN enrollments e ON e.id = pl.enrollment_id JOIN programs p ON p.id = e.program_id
        WHERE pl.id = $1 FOR UPDATE OF pl`,
      [planId],
    );
    if (plan.rowCount === 0) throw errors.notFound('Lịch kiểm tra');
    const { enrollment_id: enrollmentId, template, student_id: studentId } = plan.rows[0];
    if (!template) throw new AppError(422, 'NO_EXAM_CONTENT', 'Chương trình chưa có mẫu chấm.');

    const planUnits = await q.query<{ unit_id: string }>('SELECT unit_id FROM exam_plan_units WHERE plan_id = $1 ORDER BY sort_order', [planId]);
    const expected = planUnits.rows.map((r) => r.unit_id);
    const given = input.units.map((u) => u.unitId);
    if (new Set(given).size !== given.length || given.length !== expected.length || !expected.every((id) => given.includes(id))) {
      throw errors.validation({ units: 'Phải chấm đủ mọi Unit đã chọn, mỗi Unit một lần.' });
    }
    const fields: Record<string, string> = {};
    input.units.forEach((u, i) => {
      for (const [key, message] of Object.entries(validateUnitValues(template, u.values))) fields[`units.${i}.${key}`] = message;
    });
    if (Object.keys(fields).length > 0) throw errors.validation(fields);

    const prior = await q.query<{ id: string; thresholds: Thresholds; snapshot: ResultView['snapshot'] }>(
      'SELECT id::text AS id, thresholds, snapshot FROM exam_results WHERE plan_id = $1 FOR UPDATE',
      [planId],
    );
    const star = await q.query<{ star: boolean; redflag_below: number | null; good_above: number | null }>('SELECT star, redflag_below, good_above FROM students WHERE id = $1', [studentId]);
    const settings = await getSettings(q);
    const thresholds: Thresholds =
      prior.rowCount > 0
        ? prior.rows[0].thresholds
        : star.rows[0].star && star.rows[0].redflag_below !== null && star.rows[0].good_above !== null
          ? { redflagBelow: star.rows[0].redflag_below, goodAbove: star.rows[0].good_above }
          : { redflagBelow: settings.redflagBelow, goodAbove: settings.goodAbove };

    let snapshot = prior.rowCount > 0 ? prior.rows[0].snapshot : null;
    if (!snapshot) {
      const content = await q.query<{ id: string; name: string; topic: string; words: string[]; patterns: string[] }>(
        'SELECT u.id, u.name, u.topic, u.words, u.patterns FROM exam_plan_units pu JOIN curriculum_units u ON u.id = pu.unit_id WHERE pu.plan_id = $1 ORDER BY pu.sort_order',
        [planId],
      );
      snapshot = content.rows;
    }

    const ordered = expected.map((id) => input.units.find((u) => u.unitId === id)!);
    const summary = summarize(template, ordered, thresholds);
    let resultId: string;
    if (prior.rowCount > 0) {
      resultId = prior.rows[0].id;
      await q.query(
        `UPDATE exam_results SET comment = $2, support = $3, overall = $4, percent = $5, examiner_id = $6, examiner_name = $7, updated_at = now() WHERE id = $1`,
        [resultId, input.comment.trim(), input.support.trim(), summary.overall, summary.percent.toFixed(2), user.id, user.name],
      );
      await q.query('DELETE FROM exam_result_units WHERE result_id = $1', [resultId]);
    } else {
      const created = await q.query<{ id: string }>(
        `INSERT INTO exam_results (plan_id, enrollment_id, date, examiner_id, examiner_name, comment, support, overall, percent, thresholds, snapshot)
         VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb) RETURNING id::text AS id`,
        [planId, enrollmentId, today, user.id, user.name, input.comment.trim(), input.support.trim(), summary.overall, summary.percent.toFixed(2), JSON.stringify(thresholds), JSON.stringify(snapshot)],
      );
      resultId = created.rows[0].id;
    }
    for (const u of ordered) {
      await q.query('INSERT INTO exam_result_units (result_id, unit_id, scores) VALUES ($1, $2, $3::jsonb)', [resultId, u.unitId, JSON.stringify(u.values)]);
    }
    await q.query("UPDATE exam_plans SET status = 'done' WHERE id = $1", [planId]);
    await audit(q, {
      userId: user.id,
      entity: 'exam_result',
      entityId: resultId,
      action: prior.rowCount > 0 ? 'update' : 'create',
      detail: { planId, overall: summary.overall, percent: Number(summary.percent.toFixed(2)) },
    });
    return (await resultViews(q, 'WHERE r.id = $1', [resultId]))[0];
  });
}

/* ---------- Báo cáo ---------- */

export async function listReportStudents(db: Db): Promise<{ id: string; code: string; name: string }[]> {
  const res = await db.query<{ id: string; code: string; name: string }>(
    `SELECT s.id::text AS id, s.code, s.name FROM students s
      WHERE EXISTS (SELECT 1 FROM exam_results r JOIN enrollments e ON e.id = r.enrollment_id WHERE e.student_id = s.id)
      ORDER BY s.name, s.id`,
  );
  return res.rows;
}

export async function getStudentReport(db: Db, studentId: string, today: string) {
  const student = await db.query<{ id: string; code: string; name: string; birthday: string; star: boolean; redflag_below: number | null; good_above: number | null }>(
    'SELECT id::text AS id, code, name, birthday::text AS birthday, star, redflag_below, good_above FROM students WHERE id = $1',
    [studentId],
  );
  if (student.rowCount === 0) throw errors.notFound('Học viên');
  const s = student.rows[0];
  const settings = await getSettings(db);
  const results = await resultViews(db, 'WHERE s.id = $1', [studentId]);
  return {
    student: { id: s.id, code: s.code, name: s.name, birthday: s.birthday },
    /** Ngưỡng hiện đang áp dụng cho các lần chấm MỚI; mỗi kết quả cũ giữ ngưỡng của lần chấm đó. */
    thresholds: s.star && s.redflag_below !== null && s.good_above !== null
      ? { star: true, redflagBelow: s.redflag_below, goodAbove: s.good_above }
      : { star: false, redflagBelow: settings.redflagBelow, goodAbove: settings.goodAbove },
    results,
    generatedOn: today,
  };
}

