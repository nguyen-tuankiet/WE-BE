import type { Db, Queryable } from '../db/types.js';
import { AppError, errors } from '../errors.js';
import type { AuthUser } from '../types.js';
import { audit } from './audit.js';
import { isTeacherOnly } from './access.js';
import { queryEnrollments, type EnrollmentView } from './enrollments.js';

export interface ClassRow {
  id: string;
  name: string;
  subject: string;
  slotId: string;
  room: string;
  teacherId: string | null;
  teacherName: string | null;
  assistant: string;
  maxSize: number;
  active: boolean;
  weekdays: number[];
  studentCount: number;
}

type ClassDb = Omit<ClassRow, 'weekdays'> & { weekdays: number[] | null };

const CLASS_SELECT = `
  SELECT c.id::text AS id, c.name, c.subject, c.slot_id AS "slotId", c.room, c.teacher_id::text AS "teacherId",
         u.name AS "teacherName", c.assistant, c.max_size AS "maxSize", c.active,
         (SELECT array_agg(w.weekday::int ORDER BY w.weekday) FROM class_weekdays w WHERE w.class_id = c.id) AS weekdays,
         (SELECT count(*)::int FROM enrollments e WHERE e.class_id = c.id AND e.status = 'active') AS "studentCount"
    FROM classes c LEFT JOIN users u ON u.id = c.teacher_id`;

const toClass = (r: ClassDb): ClassRow => ({ ...r, weekdays: r.weekdays ?? [] });

/** Giáo viên thuần chỉ thấy lớp được phân công cho mình. */
export async function listClasses(db: Db, user: AuthUser): Promise<ClassRow[]> {
  const scoped = isTeacherOnly(user.roles);
  const res = await db.query<ClassDb>(`${CLASS_SELECT} ${scoped ? 'WHERE c.teacher_id = $1' : ''} ORDER BY c.name, c.id`, scoped ? [user.id] : []);
  return res.rows.map(toClass);
}

async function loadClass(q: Queryable, id: string, user: AuthUser): Promise<ClassRow> {
  const res = await q.query<ClassDb>(`${CLASS_SELECT} WHERE c.id = $1`, [id]);
  if (res.rowCount === 0) throw errors.notFound('Lớp');
  const row = toClass(res.rows[0]);
  if (isTeacherOnly(user.roles) && row.teacherId !== user.id) throw errors.forbidden();
  return row;
}

export async function getClassDetail(db: Db, user: AuthUser, id: string, today: string): Promise<{ class: ClassRow; students: EnrollmentView[] }> {
  const cls = await loadClass(db, id, user);
  const students = await queryEnrollments(db, today, "WHERE e.class_id = $2 AND e.status = 'active'", [id]);
  return { class: cls, students };
}

export interface ClassInput {
  name: string;
  subject: string;
  slotId: string;
  room: string;
  teacherId: string | null;
  assistant: string;
  maxSize: number;
  weekdays: number[];
}

async function validateRefs(q: Queryable, input: Partial<ClassInput>) {
  if (input.slotId !== undefined) {
    const r = await q.query('SELECT 1 FROM slots WHERE id = $1', [input.slotId]);
    if (r.rowCount === 0) throw errors.validation({ slotId: 'Ca học không tồn tại.' });
  }
  if (input.room !== undefined) {
    const r = await q.query('SELECT 1 FROM rooms WHERE id = $1', [input.room]);
    if (r.rowCount === 0) throw errors.validation({ room: 'Phòng không tồn tại.' });
  }
  if (input.teacherId) {
    const r = await q.query(
      `SELECT 1 FROM users u JOIN user_roles ur ON ur.user_id = u.id WHERE u.id = $1 AND u.active = true AND ur.role = 'teacher'`,
      [input.teacherId],
    );
    if (r.rowCount === 0) throw errors.validation({ teacherId: 'Giáo viên phải là tài khoản đang hoạt động có vai trò Giáo viên.' });
  }
}

async function setWeekdays(q: Queryable, classId: string, weekdays: number[]) {
  await q.query('DELETE FROM class_weekdays WHERE class_id = $1', [classId]);
  for (const d of new Set(weekdays)) await q.query('INSERT INTO class_weekdays (class_id, weekday) VALUES ($1, $2)', [classId, d]);
}

export async function createClass(db: Db, user: AuthUser, input: ClassInput): Promise<ClassRow> {
  return db.tx(async (q) => {
    await validateRefs(q, input);
    const res = await q.query<{ id: string }>(
      `INSERT INTO classes (name, subject, slot_id, room, teacher_id, assistant, max_size)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
      [input.name.trim(), input.subject.trim(), input.slotId, input.room, input.teacherId, input.assistant.trim(), input.maxSize],
    );
    const id = res.rows[0].id;
    await setWeekdays(q, id, input.weekdays);
    await audit(q, { userId: user.id, entity: 'class', entityId: id, action: 'create', detail: { name: input.name } });
    return loadClass(q, id, user);
  });
}

export interface ClassPatch extends Partial<ClassInput> {
  active?: boolean;
}

/**
 * Sửa lớp. Đổi ngày học chung của lớp chỉ ảnh hưởng lớp, KHÔNG tự đổi lịch các khóa đã có
 * (lịch từng khóa lưu theo giai đoạn có ngày hiệu lực — xem chuyển lớp ở M3).
 */
export async function updateClass(db: Db, user: AuthUser, id: string, patch: ClassPatch): Promise<ClassRow> {
  const columns: Record<string, string> = {
    name: 'name',
    subject: 'subject',
    slotId: 'slot_id',
    room: 'room',
    teacherId: 'teacher_id',
    assistant: 'assistant',
    maxSize: 'max_size',
    active: 'active',
  };
  return db.tx(async (q) => {
    const cur = await q.query('SELECT 1 FROM classes WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) throw errors.notFound('Lớp');
    await validateRefs(q, patch);
    if (patch.maxSize !== undefined) {
      const n = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM enrollments WHERE class_id = $1 AND status = 'active'", [id]);
      if (patch.maxSize < n.rows[0].n) throw new AppError(422, 'CLASS_OVER_CAPACITY', `Lớp đang có ${n.rows[0].n} học viên, không thể đặt sĩ số tối đa thấp hơn.`);
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const [key, column] of Object.entries(columns)) {
      const v = (patch as Record<string, unknown>)[key];
      if (v === undefined) continue;
      params.push(typeof v === 'string' ? v.trim() : v);
      sets.push(`${column} = $${params.length}`);
    }
    if (sets.length > 0) await q.query(`UPDATE classes SET ${sets.join(', ')} WHERE id = $1`, params);
    if (patch.weekdays) await setWeekdays(q, id, patch.weekdays);
    await audit(q, { userId: user.id, entity: 'class', entityId: id, action: 'update', detail: { fields: Object.keys(patch) } });
    return loadClass(q, id, user);
  });
}
