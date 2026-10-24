import type { Db, Queryable } from '../db/types.js';
import { diffDays } from '../domain/dates.js';
import { AppError, errors } from '../errors.js';
import type { AuthUser } from '../types.js';
import { isTeacherOnly } from './access.js';
import { audit } from './audit.js';
import { getSettings } from './reference.js';

export type AttendanceStatus = 'present' | 'late' | 'absent';

/** Giáo viên thuần chỉ điểm danh lớp được phân công; Admin/Manager điểm danh mọi lớp. */
async function assertClassAccess(q: Queryable, user: AuthUser, classId: string): Promise<void> {
  const res = await q.query<{ teacher_id: string | null }>('SELECT teacher_id::text AS teacher_id FROM classes WHERE id = $1', [classId]);
  if (res.rowCount === 0) throw errors.notFound('Lớp');
  if (isTeacherOnly(user.roles) && res.rows[0].teacher_id !== user.id) {
    throw new AppError(403, 'FORBIDDEN_CLASS', 'Bạn chỉ điểm danh được các lớp được phân công cho mình.');
  }
}

export type LockReason = 'FUTURE_DATE' | 'EDIT_WINDOW_EXPIRED';

/**
 * Ngày này có được ghi/sửa không? Chưa tới ngày học thì không; giáo viên chỉ sửa trong `teacherEditDays` ngày gần nhất
 * (cấu hình, chưa chốt chính thức — docs/08 #6). Admin/Manager xử lý các ngày khác.
 */
function lockReason(user: AuthUser, date: string, today: string, teacherEditDays: number): LockReason | null {
  if (date > today) return 'FUTURE_DATE';
  if (isTeacherOnly(user.roles) && diffDays(today, date) > teacherEditDays) return 'EDIT_WINDOW_EXPIRED';
  return null;
}

/* ---------- Sổ ngày ---------- */

export interface SheetRow {
  enrollmentId: string;
  studentId: string;
  studentCode: string;
  studentName: string;
  programName: string;
  /** null = Chưa ghi nhận */
  record: null | { status: AttendanceStatus; notified: boolean; note: string; by: string | null; updatedAt: string };
  /** Lượt bù (còn hiệu lực) rơi vào ngày này, ví dụ buổi chính 90' kèm bù 30' */
  makeups: { id: string; minutes: number; status: string }[];
}

export interface Sheet {
  classId: string;
  date: string;
  editable: boolean;
  lockReason: LockReason | null;
  teacherEditDays: number;
  rows: SheetRow[];
}

interface SheetDbRow {
  enrollment_id: string;
  student_id: string;
  student_code: string;
  student_name: string;
  program_name: string;
  status: AttendanceStatus | null;
  notified: boolean | null;
  note: string | null;
  by_name: string | null;
  updated_at: string | null;
}

/** Học viên có buổi chính trong ngày này ở lớp này (theo lịch của từng khóa) kèm kết quả điểm danh nếu có. */
export async function getSheet(db: Db, user: AuthUser, classId: string, date: string, today: string): Promise<Sheet> {
  await assertClassAccess(db, user, classId);
  const settings = await getSettings(db);
  const res = await db.query<SheetDbRow>(
    `SELECT e.id::text AS enrollment_id, s.id::text AS student_id, s.code AS student_code, s.name AS student_name, p.name AS program_name,
            a.status, a.notified, a.note, u.name AS by_name,
            to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
       FROM course_sessions cs
       JOIN enrollments e ON e.id = cs.enrollment_id
       JOIN students s ON s.id = e.student_id
       JOIN programs p ON p.id = e.program_id
       LEFT JOIN attendance a ON a.enrollment_id = cs.enrollment_id AND a.date = cs.date
       LEFT JOIN users u ON u.id = COALESCE(a.updated_by, a.recorded_by)
      WHERE cs.date = $1::date AND cs.class_id = $2 AND e.status <> 'completed'
      ORDER BY s.name, e.id`,
    [date, classId],
  );
  const reason = lockReason(user, date, today, settings.teacherEditDays);
  const mk = await db.query<{ enrollment_id: string; id: string; minutes: number; status: string }>(
    "SELECT enrollment_id::text AS enrollment_id, id::text AS id, minutes, status FROM makeups WHERE date = $1::date AND status <> 'cancelled' AND enrollment_id = ANY($2::bigint[])",
    [date, res.rows.map((r) => r.enrollment_id)],
  );
  return {
    classId,
    date,
    editable: reason === null,
    lockReason: reason,
    teacherEditDays: settings.teacherEditDays,
    rows: res.rows.map((r) => ({
      enrollmentId: r.enrollment_id,
      studentId: r.student_id,
      studentCode: r.student_code,
      studentName: r.student_name,
      programName: r.program_name,
      record: r.status
        ? { status: r.status, notified: !!r.notified, note: r.note ?? '', by: r.by_name, updatedAt: r.updated_at ?? '' }
        : null,
      makeups: mk.rows.filter((m) => m.enrollment_id === r.enrollment_id).map((m) => ({ id: m.id, minutes: m.minutes, status: m.status })),
    })),
  };
}

/* ---------- Ghi điểm danh ---------- */

export interface AttendanceItem {
  enrollmentId: string;
  status: AttendanceStatus;
  notified: boolean;
  note: string;
}

export interface SaveResult {
  saved: number;
  changed: number;
}

/**
 * Ghi điểm danh hàng loạt cho một lớp trong một ngày — tất cả hoặc không gì cả (một giao dịch).
 * Chỉ nhận học viên có buổi chính ngày đó ở lớp này; ghi lại cùng giá trị không tạo thay đổi/nhật ký mới.
 */
export async function saveAttendance(
  db: Db,
  user: AuthUser,
  input: { classId: string; date: string; items: AttendanceItem[] },
  today: string,
): Promise<SaveResult> {
  const ids = input.items.map((i) => i.enrollmentId);
  if (new Set(ids).size !== ids.length) throw errors.validation({ items: 'Mỗi học viên chỉ được xuất hiện một lần trong danh sách.' });

  return db.tx(async (q) => {
    await assertClassAccess(q, user, input.classId);
    const settings = await getSettings(q);
    const reason = lockReason(user, input.date, today, settings.teacherEditDays);
    if (reason === 'FUTURE_DATE') throw new AppError(422, 'FUTURE_DATE', 'Chưa tới ngày học, chưa thể điểm danh.');
    if (reason === 'EDIT_WINDOW_EXPIRED') {
      throw new AppError(403, 'EDIT_WINDOW_EXPIRED', `Giáo viên chỉ sửa điểm danh trong ${settings.teacherEditDays} ngày gần nhất. Liên hệ Admin/Manager để điều chỉnh.`);
    }

    const scheduled = await q.query<{ enrollment_id: string }>(
      'SELECT enrollment_id::text AS enrollment_id FROM course_sessions WHERE date = $1::date AND class_id = $2',
      [input.date, input.classId],
    );
    const inClass = new Set(scheduled.rows.map((r) => r.enrollment_id));
    const outside = ids.filter((id) => !inClass.has(id));
    if (outside.length > 0) {
      throw new AppError(422, 'OUT_OF_SCHEDULE', 'Có học viên không có buổi học trong ngày này ở lớp này. Không ghi buổi chính vào ngày ngoài lịch khóa.');
    }

    const existing = await q.query<{ enrollment_id: string; status: AttendanceStatus; notified: boolean; note: string }>(
      'SELECT enrollment_id::text AS enrollment_id, status, notified, note FROM attendance WHERE date = $1::date AND enrollment_id = ANY($2::bigint[])',
      [input.date, ids],
    );
    const before = new Map(existing.rows.map((r) => [r.enrollment_id, r]));

    // Buổi vắng đã báo nghỉ mà đã có lịch bù thì phải đối chiếu lượt bù trước khi đổi trạng thái hoặc bỏ điều kiện báo nghỉ.
    const covered = await q.query<{ enrollment_id: string }>(
      "SELECT enrollment_id::text AS enrollment_id FROM makeups WHERE absence_date = $1::date AND status <> 'cancelled' AND enrollment_id = ANY($2::bigint[])",
      [input.date, ids],
    );
    const hasMakeup = new Set(covered.rows.map((r) => r.enrollment_id));
    for (const item of input.items) {
      if (hasMakeup.has(item.enrollmentId) && (item.status !== 'absent' || !item.notified)) {
        throw new AppError(409, 'MAKEUP_EXISTS', 'Buổi vắng này đã có lịch bù. Hãy hủy hoặc đối chiếu lượt bù trước khi đổi trạng thái hay bỏ "đã báo nghỉ".');
      }
    }

    let changed = 0;
    for (const item of input.items) {
      const prev = before.get(item.enrollmentId);
      const note = item.note.trim();
      if (prev && prev.status === item.status && prev.notified === item.notified && prev.note === note) continue;
      await q.query(
        `INSERT INTO attendance (enrollment_id, date, class_id, status, notified, note, recorded_by, updated_by)
         VALUES ($1, $2::date, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (enrollment_id, date) DO UPDATE
           SET status = EXCLUDED.status, notified = EXCLUDED.notified, note = EXCLUDED.note,
               updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [item.enrollmentId, input.date, input.classId, item.status, item.notified, note, user.id],
      );
      await audit(q, {
        userId: user.id,
        entity: 'attendance',
        entityId: `${item.enrollmentId}|${input.date}`,
        action: prev ? 'update' : 'create',
        detail: {
          before: prev ? { status: prev.status, notified: prev.notified, note: prev.note } : null,
          after: { status: item.status, notified: item.notified, note },
        },
      });
      changed += 1;
    }
    return { saved: input.items.length, changed };
  });
}

/* ---------- Sổ tháng ---------- */

export type LedgerStatus = AttendanceStatus | 'none' | 'future' | 'off';

export interface LedgerRow {
  enrollmentId: string;
  studentId: string;
  studentName: string;
  programName: string;
  cells: { date: string; status: LedgerStatus; notified: boolean; makeupMinutes?: number }[];
}

/** Sổ tháng của một lớp: mỗi ô là một buổi. `none` = đã tới hạn nhưng Chưa ghi nhận; `off` = học viên không có buổi ngày đó. */
export async function getLedger(db: Db, user: AuthUser, classId: string, month: string, today: string): Promise<{ dates: string[]; rows: LedgerRow[] }> {
  await assertClassAccess(db, user, classId);
  const res = await db.query<{
    enrollment_id: string;
    student_id: string;
    student_name: string;
    program_name: string;
    date: string;
    status: AttendanceStatus | null;
    notified: boolean | null;
  }>(
    `SELECT e.id::text AS enrollment_id, s.id::text AS student_id, s.name AS student_name, p.name AS program_name,
            cs.date::text AS date, a.status, a.notified
       FROM course_sessions cs
       JOIN enrollments e ON e.id = cs.enrollment_id
       JOIN students s ON s.id = e.student_id
       JOIN programs p ON p.id = e.program_id
       LEFT JOIN attendance a ON a.enrollment_id = cs.enrollment_id AND a.date = cs.date
      WHERE cs.class_id = $1 AND cs.date >= $2::date AND cs.date < ($2::date + interval '1 month')::date
      ORDER BY s.name, e.id, cs.date`,
    [classId, `${month}-01`],
  );
  const mk = await db.query<{ enrollment_id: string; date: string; minutes: number }>(
    "SELECT enrollment_id::text AS enrollment_id, date::text AS date, minutes FROM makeups WHERE status <> 'cancelled' AND enrollment_id = ANY($1::bigint[]) AND date >= $2::date AND date < ($2::date + interval '1 month')::date",
    [[...new Set(res.rows.map((r) => r.enrollment_id))], `${month}-01`],
  );
  const makeupAt = new Map(mk.rows.map((m) => [`${m.enrollment_id}|${m.date}`, m.minutes]));
  const dates = [...new Set(res.rows.map((r) => r.date))].sort();
  const byEnrollment = new Map<string, LedgerRow & { map: Map<string, { status: LedgerStatus; notified: boolean }> }>();
  for (const r of res.rows) {
    let row = byEnrollment.get(r.enrollment_id);
    if (!row) {
      row = { enrollmentId: r.enrollment_id, studentId: r.student_id, studentName: r.student_name, programName: r.program_name, cells: [], map: new Map() };
      byEnrollment.set(r.enrollment_id, row);
    }
    const status: LedgerStatus = r.status ?? (r.date > today ? 'future' : 'none');
    row.map.set(r.date, { status, notified: !!r.notified });
  }
  const rows: LedgerRow[] = [...byEnrollment.values()].map(({ map, ...row }) => ({
    ...row,
    cells: dates.map((date) => {
      const minutes = makeupAt.get(`${row.enrollmentId}|${date}`);
      return { date, ...(map.get(date) ?? { status: 'off' as const, notified: false }), ...(minutes ? { makeupMinutes: minutes } : {}) };
    }),
  }));
  return { dates, rows };
}
