import type { Db, Queryable } from '../db/types.js';
import { AppError, errors } from '../errors.js';
import type { AuthUser } from '../types.js';
import { audit } from './audit.js';
import { canSeePrivate, isTeacherOnly } from './access.js';
import { queryEnrollments, type EnrollmentView } from './enrollments.js';
import { reservesOfStudent, type ReserveView } from './reserves.js';

export interface StudentRow {
  id: string;
  code: string;
  name: string;
  birthday: string;
  status: string;
  star: boolean;
  redflagBelow: number | null;
  goodAbove: number | null;
  nextCourse: string;
  className: string | null;
  activeCourses: number;
  /** Chỉ có với Admin/Manager */
  guardian?: string;
  phone?: string;
  address?: string;
  tuitionMode?: string;
  note?: string;
}

const STUDENT_SELECT = `
  SELECT s.id::text AS id, s.code, s.name, s.birthday::text AS birthday, s.status, s.star,
         s.redflag_below AS "redflagBelow", s.good_above AS "goodAbove", s.next_course AS "nextCourse",
         s.guardian, s.phone, s.address, s.tuition_mode AS "tuitionMode", s.note,
         (SELECT c.name FROM enrollments e JOIN classes c ON c.id = e.class_id
           WHERE e.student_id = s.id AND e.status = 'active' ORDER BY e.id LIMIT 1) AS "className",
         (SELECT count(*)::int FROM enrollments e WHERE e.student_id = s.id AND e.status = 'active') AS "activeCourses"
    FROM students s`;

const teacherScope = (param: number) => `EXISTS (SELECT 1 FROM enrollments e JOIN classes c ON c.id = e.class_id
   WHERE e.student_id = s.id AND e.status IN ('active', 'reserved') AND c.teacher_id = $${param})`;

function shape(row: StudentRow, user: AuthUser): StudentRow {
  if (canSeePrivate(user.roles)) return row;
  const { guardian: _g, phone: _p, address: _a, tuitionMode: _t, note: _n, ...rest } = row;
  return rest;
}

export async function listStudents(db: Db, user: AuthUser): Promise<StudentRow[]> {
  const scoped = isTeacherOnly(user.roles);
  const res = await db.query<StudentRow>(`${STUDENT_SELECT} ${scoped ? `WHERE ${teacherScope(1)}` : ''} ORDER BY s.name, s.id`, scoped ? [user.id] : []);
  return res.rows.map((r) => shape(r, user));
}

async function loadStudent(q: Queryable, id: string, user: AuthUser): Promise<StudentRow> {
  const scoped = isTeacherOnly(user.roles);
  const res = await q.query<StudentRow>(
    `${STUDENT_SELECT} WHERE s.id = $1 ${scoped ? `AND ${teacherScope(2)}` : ''}`,
    scoped ? [id, user.id] : [id],
  );
  if (res.rowCount === 0) {
    // Không phân biệt "không tồn tại" và "không thuộc lớp được giao" để không lộ dữ liệu.
    throw scoped ? errors.forbidden() : errors.notFound('Học viên');
  }
  return shape(res.rows[0], user);
}

export interface StudentProfile {
  student: StudentRow;
  enrollments: EnrollmentView[];
  attendance: { present: number; late: number; absent: number };
  /** Chỉ Admin/Manager thấy giá trị tiền bảo lưu */
  reserves: ReserveView[];
  /** Tóm tắt các lần kiểm tra (Admin/Manager/Thanh tra); giáo viên chưa được xem */
  exams: { id: string; date: string; program: string; percent: number; overall: string }[];
}

export async function getStudentProfile(db: Db, user: AuthUser, id: string, today: string): Promise<StudentProfile> {
  const student = await loadStudent(db, id, user);
  const enrollments = await queryEnrollments(db, today, 'WHERE e.student_id = $2', [id]);
  const counts = await db.query<{ status: 'present' | 'late' | 'absent'; n: number }>(
    `SELECT a.status, count(*)::int AS n FROM attendance a JOIN enrollments e ON e.id = a.enrollment_id WHERE e.student_id = $1 GROUP BY a.status`,
    [id],
  );
  const attendance = { present: 0, late: 0, absent: 0 };
  for (const r of counts.rows) attendance[r.status] = r.n;
  const reserves = (await reservesOfStudent(db, id, today)).map((r) => (canSeePrivate(user.roles) ? r : { ...r, amount: 0 }));
  const canSeeExams = user.roles.some((r) => r === 'admin' || r === 'manager' || r === 'inspector');
  const exams = canSeeExams
    ? (
        await db.query<{ id: string; date: string; program: string; percent: string; overall: string }>(
          `SELECT r.id::text AS id, r.date::text AS date, p.name AS program, r.percent::text AS percent, r.overall
             FROM exam_results r JOIN enrollments e ON e.id = r.enrollment_id JOIN programs p ON p.id = e.program_id
            WHERE e.student_id = $1 ORDER BY r.date DESC, r.id DESC`,
          [id],
        )
      ).rows.map((r) => ({ ...r, percent: Number(r.percent) }))
    : [];
  return { student, enrollments: canSeePrivate(user.roles) ? enrollments : enrollments.map((e) => ({ ...e, tuition: 0, tuitionReceived: false })), attendance, reserves, exams };
}

export interface NewStudent {
  name: string;
  birthday: string;
  guardian: string;
  phone: string;
  address: string;
  tuitionMode: string;
  note: string;
}

/** Mã học viên (HV0001…) lấy từ dãy số riêng, bất biến và không bao giờ tái sử dụng. Trùng tên vẫn có mã riêng; không tự gộp hồ sơ. */
export async function createStudent(db: Db, user: AuthUser, input: NewStudent): Promise<StudentRow> {
  return db.tx(async (q) => {
    const res = await q.query<{ id: string }>(
      `INSERT INTO students (code, name, birthday, guardian, phone, address, tuition_mode, note)
       VALUES ('HV' || lpad(nextval('student_code_seq')::text, 4, '0'), $1, $2::date, $3, $4, $5, $6, $7) RETURNING id::text AS id`,
      [input.name.trim(), input.birthday, input.guardian.trim(), input.phone.trim(), input.address.trim(), input.tuitionMode.trim(), input.note.trim()],
    );
    const id = res.rows[0].id;
    await audit(q, { userId: user.id, entity: 'student', entityId: id, action: 'create', detail: { name: input.name } });
    return loadStudent(q, id, user);
  });
}

export interface StudentPatch extends Partial<NewStudent> {
  nextCourse?: string;
  /** Chỉ đổi thủ công giữa Đang học và Đã nghỉ; trạng thái Bảo lưu do thủ tục bảo lưu quyết định. */
  status?: 'active' | 'left';
}

const PATCH_COLUMNS: Record<keyof StudentPatch, string> = {
  name: 'name',
  birthday: 'birthday',
  guardian: 'guardian',
  phone: 'phone',
  address: 'address',
  tuitionMode: 'tuition_mode',
  note: 'note',
  nextCourse: 'next_course',
  status: 'status',
};

export async function updateStudent(db: Db, user: AuthUser, id: string, patch: StudentPatch): Promise<StudentRow> {
  return db.tx(async (q) => {
    const cur = await q.query<{ status: string }>('SELECT status FROM students WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) throw errors.notFound('Học viên');
    const activeReserve = await q.query("SELECT 1 FROM reserves r JOIN enrollments e ON e.id = r.enrollment_id WHERE e.student_id = $1 AND r.status = 'active'", [id]);
    if (cur.rows[0].status === 'reserved' && patch.status !== undefined && activeReserve.rowCount > 0) {
      throw new AppError(422, 'STUDENT_RESERVED', 'Học viên đang bảo lưu, trạng thái được quản lý qua thủ tục bảo lưu.');
    }
    if (patch.status === 'left' && cur.rows[0].status !== 'left') {
      const active = await q.query("SELECT 1 FROM enrollments WHERE student_id = $1 AND status IN ('active', 'reserved')", [id]);
      if (active.rowCount > 0) {
        throw new AppError(422, 'STUDENT_HAS_ACTIVE_ENROLLMENTS', 'Học viên còn khóa đang học hoặc đang bảo lưu: kết thúc các khóa này trước khi đánh dấu nghỉ học.');
      }
    }
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of Object.keys(PATCH_COLUMNS) as (keyof StudentPatch)[]) {
      const v = patch[key];
      if (v === undefined) continue;
      params.push(typeof v === 'string' ? v.trim() : v);
      sets.push(`${PATCH_COLUMNS[key]} = $${params.length}${key === 'birthday' ? '::date' : ''}`);
    }
    if (sets.length > 0) await q.query(`UPDATE students SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params);
    await audit(q, { userId: user.id, entity: 'student', entityId: id, action: 'update', detail: { fields: Object.keys(patch) } });
    return loadStudent(q, id, user);
  });
}

/** Dấu sao: áp ngưỡng Redflag/Good riêng. Điểm gốc luôn giữ; chỉ đổi cách phân loại các lần chấm SAU đó (docs/08 #5 chờ chốt). */
export async function setStudentStar(
  db: Db,
  user: AuthUser,
  id: string,
  input: { star: boolean; redflagBelow?: number; goodAbove?: number },
): Promise<StudentRow> {
  if (input.star && (input.redflagBelow === undefined || input.goodAbove === undefined || input.redflagBelow >= input.goodAbove)) {
    throw errors.validation({ redflagBelow: 'Cần nhập ngưỡng Redflag thấp hơn ngưỡng Good khi bật dấu sao.' });
  }
  return db.tx(async (q) => {
    const cur = await q.query('SELECT 1 FROM students WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) throw errors.notFound('Học viên');
    await q.query('UPDATE students SET star = $2, redflag_below = $3, good_above = $4, updated_at = now() WHERE id = $1', [
      id,
      input.star,
      input.star ? input.redflagBelow : null,
      input.star ? input.goodAbove : null,
    ]);
    await audit(q, { userId: user.id, entity: 'student', entityId: id, action: 'star', detail: { ...input } });
    return loadStudent(q, id, user);
  });
}
