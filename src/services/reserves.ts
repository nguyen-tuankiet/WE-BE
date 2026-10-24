import type { Db, Queryable } from '../db/types.js';
import { diffDays } from '../domain/dates.js';
import { AppError, errors } from '../errors.js';
import type { AuthUser } from '../types.js';
import { audit } from './audit.js';
import { getEnrollment, regenerateFrom, type EnrollmentView } from './enrollments.js';

export interface ReserveView {
  id: string;
  enrollmentId: string;
  student: { id: string; name: string; status: string };
  program: { id: string; name: string };
  class: { id: string; name: string };
  noticeAt: string;
  completedOn: string;
  expiresOn: string;
  /** Số ngày còn lại tới hạn (chỉ khi đang bảo lưu) */
  daysLeft: number | null;
  absentStreak: number;
  remainingSessions: number;
  amount: number;
  status: 'active' | 'returned' | 'expired';
  returnedOn: string | null;
  returnClassId: string | null;
  note: string;
}

interface ReserveDbRow {
  id: string;
  enrollment_id: string;
  student_id: string;
  student_name: string;
  student_status: string;
  program_id: string;
  program_name: string;
  class_id: string;
  class_name: string;
  notice_at: string;
  completed_on: string;
  expires_on: string;
  absent_streak: number;
  remaining_sessions: number;
  amount: string;
  status: 'active' | 'returned' | 'expired';
  returned_on: string | null;
  return_class_id: string | null;
  note: string;
}

const RESERVE_SQL = `
  SELECT r.id::text AS id, r.enrollment_id::text AS enrollment_id, s.id::text AS student_id, s.name AS student_name, s.status AS student_status,
         p.id AS program_id, p.name AS program_name, c.id::text AS class_id, c.name AS class_name,
         to_char(r.notice_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS notice_at,
         r.completed_on::text AS completed_on, r.expires_on::text AS expires_on, r.absent_streak, r.remaining_sessions,
         r.amount::text AS amount, r.status, r.returned_on::text AS returned_on, r.return_class_id::text AS return_class_id, r.note
    FROM reserves r
    JOIN enrollments e ON e.id = r.enrollment_id
    JOIN students s ON s.id = e.student_id
    JOIN programs p ON p.id = e.program_id
    JOIN classes c ON c.id = e.class_id`;

const toView = (r: ReserveDbRow, today: string): ReserveView => ({
  id: r.id,
  enrollmentId: r.enrollment_id,
  student: { id: r.student_id, name: r.student_name, status: r.student_status },
  program: { id: r.program_id, name: r.program_name },
  class: { id: r.class_id, name: r.class_name },
  noticeAt: r.notice_at,
  completedOn: r.completed_on,
  expiresOn: r.expires_on,
  daysLeft: r.status === 'active' ? diffDays(r.expires_on, today) : null,
  absentStreak: r.absent_streak,
  remainingSessions: r.remaining_sessions,
  amount: Number(r.amount),
  status: r.status,
  returnedOn: r.returned_on,
  returnClassId: r.return_class_id,
  note: r.note,
});

/**
 * Hết hạn (2 tháng kể từ ngày hoàn tất): giá trị bảo lưu hết hiệu lực, muốn học lại phải đăng ký và thanh toán lại theo quy định.
 * Chạy khi đọc/nhập học lại. Học viên chuyển "Đã nghỉ" nếu không còn khóa nào khác (tạm thời — docs/08 #2 chờ chốt thời điểm đóng trạng thái).
 */
export async function expireReserves(q: Queryable, today: string): Promise<number> {
  const res = await q.query<{ id: string; student_id: string }>(
    `UPDATE reserves r SET status = 'expired', updated_at = now()
      WHERE r.status = 'active' AND r.expires_on < $1::date
  RETURNING r.id::text AS id, (SELECT e.student_id::text FROM enrollments e WHERE e.id = r.enrollment_id) AS student_id`,
    [today],
  );
  for (const r of res.rows) {
    await q.query(
      `UPDATE students SET status = 'left', updated_at = now()
        WHERE id = $1 AND status = 'reserved'
          AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = students.id AND e.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM enrollments e JOIN reserves x ON x.enrollment_id = e.id WHERE e.student_id = students.id AND x.status = 'active')`,
      [r.student_id],
    );
    await audit(q, { userId: null, entity: 'reserve', entityId: r.id, action: 'expire' });
  }
  return res.rowCount;
}

export async function listReserves(db: Db, today: string): Promise<ReserveView[]> {
  await db.tx((q) => expireReserves(q, today));
  const res = await db.query<ReserveDbRow>(`${RESERVE_SQL} ORDER BY r.status, r.expires_on, r.id`);
  return res.rows.map((r) => toView(r, today));
}

export async function reservesOfStudent(q: Queryable, studentId: string, today: string): Promise<ReserveView[]> {
  const res = await q.query<ReserveDbRow>(`${RESERVE_SQL} WHERE s.id = $1 ORDER BY r.id`, [studentId]);
  return res.rows.map((r) => toView(r, today));
}

/** Thời điểm hiệu lực = 00:00 (giờ Việt Nam) của ngày hoàn tất thủ tục. */
const effectiveAt = (completedOn: string) => new Date(`${completedOn}T00:00:00+07:00`);

/** `YYYY-MM-DDTHH:mm` không có múi giờ được hiểu là giờ Việt Nam. */
export function parseNotice(value: string): Date | null {
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(value);
  const text = hasZone ? value : `${value.length === 16 ? `${value}:00` : value}+07:00`;
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

export interface NewReserve {
  enrollmentId: string;
  noticeAt: string;
  completedOn: string;
  absentStreak: number;
  amount: number;
  note: string;
}

/**
 * Tạo bảo lưu theo chính sách (docs/02): nghỉ liên tục ≥ 10 buổi, báo trước ≥ 48 giờ (tính tới 00:00 ngày hoàn tất), tối đa 1 lần/khóa,
 * chỉ bảo lưu học phí phần chưa diễn ra (không vượt học phí đã đóng), hạn 2 tháng, không hoàn tiền.
 * Lịch chính từ ngày hoàn tất tạm dừng: các buổi sau đó bị gỡ (không sinh buổi vắng) cho tới khi nhập học lại.
 */
export async function createReserve(
  db: Db,
  user: AuthUser,
  input: NewReserve,
  today: string,
): Promise<{ reserve: ReserveView; suggestedAmount: number }> {
  const notice = parseNotice(input.noticeAt);
  if (!notice) throw errors.validation({ noticeAt: 'Thời điểm thông báo không hợp lệ.' });

  return db.tx(async (q) => {
    const enr = await q.query<{ status: string; start_date: string; tuition: string; total_sessions: number; student_id: string }>(
      'SELECT status, start_date::text AS start_date, tuition::text AS tuition, total_sessions, student_id::text AS student_id FROM enrollments WHERE id = $1 FOR UPDATE',
      [input.enrollmentId],
    );
    if (enr.rowCount === 0) throw errors.notFound('Khóa đăng ký');
    const e = enr.rows[0];
    const used = await q.query('SELECT 1 FROM reserves WHERE enrollment_id = $1', [input.enrollmentId]);
    if (used.rowCount > 0) throw new AppError(409, 'RESERVE_ALREADY_USED', 'Khóa này đã bảo lưu một lần. Chính sách chỉ cho phép bảo lưu một lần duy nhất cho học phí của khóa.');
    if (e.status !== 'active') throw new AppError(422, 'ENROLLMENT_NOT_ACTIVE', 'Chỉ bảo lưu cho khóa đang học.');

    if (input.absentStreak < 10) {
      throw new AppError(422, 'RESERVE_STREAK_TOO_SHORT', 'Chỉ bảo lưu khi nghỉ liên tục từ 10 buổi trở lên.');
    }
    const hours = (effectiveAt(input.completedOn).getTime() - notice.getTime()) / 3_600_000;
    if (hours < 48) {
      throw new AppError(422, 'RESERVE_NOTICE_TOO_SHORT', `Cần thông báo trước ít nhất 48 giờ (hiện chỉ ${Math.max(Math.floor(hours), 0)} giờ).`);
    }
    if (input.completedOn < e.start_date) throw errors.validation({ completedOn: 'Ngày hoàn tất không được trước ngày bắt đầu khóa.' });
    if (Number(e.tuition) < input.amount) {
      throw new AppError(422, 'RESERVE_AMOUNT_TOO_HIGH', 'Giá trị bảo lưu không được vượt học phí của khóa.');
    }

    const attended = await q.query('SELECT 1 FROM attendance WHERE enrollment_id = $1 AND date >= $2::date LIMIT 1', [input.enrollmentId, input.completedOn]);
    if (attended.rowCount > 0) {
      throw new AppError(409, 'RESERVE_HAS_ATTENDANCE', 'Đã có điểm danh từ ngày hoàn tất trở đi. Hãy đối chiếu điểm danh hoặc chọn ngày hoàn tất muộn hơn.');
    }
    const left = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM course_sessions WHERE enrollment_id = $1 AND date >= $2::date', [input.enrollmentId, input.completedOn]);
    if (left.rows[0].n === 0) throw new AppError(422, 'RESERVE_NOTHING_LEFT', 'Không còn buổi chưa diễn ra để bảo lưu.');

    const created = await q.query<{ id: string }>(
      `INSERT INTO reserves (enrollment_id, notice_at, completed_on, expires_on, absent_streak, remaining_sessions, amount, note, created_by)
       VALUES ($1, $2::timestamptz, $3::date, ($3::date + interval '2 months')::date, $4, $5, $6, $7, $8) RETURNING id::text AS id`,
      [input.enrollmentId, notice.toISOString(), input.completedOn, input.absentStreak, left.rows[0].n, input.amount, input.note.trim(), user.id],
    );
    const id = created.rows[0].id;

    await q.query('DELETE FROM course_sessions WHERE enrollment_id = $1 AND date >= $2::date', [input.enrollmentId, input.completedOn]);
    await q.query("UPDATE enrollments SET status = 'reserved', updated_at = now() WHERE id = $1", [input.enrollmentId]);
    // Bảo lưu một khóa không mặc nhiên là ngừng cả hồ sơ: chỉ đổi trạng thái học viên khi không còn khóa nào đang học.
    await q.query(
      `UPDATE students SET status = 'reserved', updated_at = now()
        WHERE id = $1 AND status = 'active' AND NOT EXISTS (SELECT 1 FROM enrollments e WHERE e.student_id = students.id AND e.status = 'active')`,
      [e.student_id],
    );
    await audit(q, {
      userId: user.id,
      entity: 'reserve',
      entityId: id,
      action: 'create',
      detail: { enrollmentId: input.enrollmentId, completedOn: input.completedOn, remainingSessions: left.rows[0].n, amount: input.amount },
    });

    const row = await q.query<ReserveDbRow>(`${RESERVE_SQL} WHERE r.id = $1`, [id]);
    return {
      reserve: toView(row.rows[0], today),
      suggestedAmount: Math.floor((Number(e.tuition) * left.rows[0].n) / e.total_sessions),
    };
  });
}

/**
 * Nhập học lại: xếp lớp phù hợp rồi TIẾP TỤC số buổi còn lại (mặc định của bản đầu; học lại từ đầu hay dùng tiền bảo lưu thế nào đang chờ chốt — docs/08 #1).
 * Giữ nguyên lịch sử trước đó; khoảng bảo lưu không có buổi nào.
 */
export async function returnFromReserve(
  db: Db,
  user: AuthUser,
  id: string,
  input: { classId: string; returnedOn: string },
  today: string,
): Promise<{ reserve: ReserveView; enrollment: EnrollmentView }> {
  return db.tx(async (q) => {
    await expireReserves(q, today);
    const cur = await q.query<{ enrollment_id: string; status: string; completed_on: string; expires_on: string }>(
      'SELECT enrollment_id::text AS enrollment_id, status, completed_on::text AS completed_on, expires_on::text AS expires_on FROM reserves WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (cur.rowCount === 0) throw errors.notFound('Hồ sơ bảo lưu');
    const r = cur.rows[0];
    if (r.status === 'expired' || input.returnedOn > r.expires_on) {
      throw new AppError(422, 'RESERVE_EXPIRED', 'Bảo lưu đã hết hạn 2 tháng. Giá trị bảo lưu hết hiệu lực, cần đăng ký lại và thanh toán theo quy định.');
    }
    if (r.status !== 'active') throw new AppError(422, 'RESERVE_NOT_ACTIVE', 'Hồ sơ bảo lưu này không còn ở trạng thái đang bảo lưu.');
    if (input.returnedOn < r.completed_on) throw errors.validation({ returnedOn: 'Ngày quay lại không được trước ngày hoàn tất bảo lưu.' });

    const cls = await q.query<{ active: boolean; max_size: number }>('SELECT active, max_size FROM classes WHERE id = $1 FOR UPDATE', [input.classId]);
    if (cls.rowCount === 0) throw errors.notFound('Lớp');
    if (!cls.rows[0].active) throw new AppError(422, 'CLASS_INACTIVE', 'Lớp đã ngừng hoạt động.');
    const taken = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM enrollments WHERE class_id = $1 AND status = 'active'", [input.classId]);
    if (taken.rows[0].n >= cls.rows[0].max_size) throw new AppError(422, 'CLASS_FULL', 'Lớp đã đủ sĩ số tối đa.');
    const days = await q.query<{ weekday: number }>('SELECT weekday::int AS weekday FROM class_weekdays WHERE class_id = $1 ORDER BY weekday', [input.classId]);
    if (days.rowCount === 0) throw new AppError(422, 'NO_WEEKDAYS', 'Lớp được xếp chưa có ngày học.');

    await q.query(
      `UPDATE reserves SET status = 'returned', returned_on = $2::date, return_class_id = $3, updated_at = now() WHERE id = $1`,
      [id, input.returnedOn, input.classId],
    );
    await q.query("UPDATE enrollments SET status = 'active', class_id = $2, updated_at = now() WHERE id = $1", [r.enrollment_id, input.classId]);
    await q.query(
      `INSERT INTO enrollment_schedule (enrollment_id, effective_from, class_id, weekdays) VALUES ($1, $2::date, $3, $4::smallint[])
       ON CONFLICT (enrollment_id, effective_from) DO UPDATE SET class_id = EXCLUDED.class_id, weekdays = EXCLUDED.weekdays`,
      [r.enrollment_id, input.returnedOn, input.classId, days.rows.map((d) => d.weekday)],
    );
    await regenerateFrom(q, r.enrollment_id, input.returnedOn);
    await q.query(
      `UPDATE students SET status = 'active', updated_at = now()
        WHERE id = (SELECT student_id FROM enrollments WHERE id = $1) AND status = 'reserved'`,
      [r.enrollment_id],
    );
    await audit(q, { userId: user.id, entity: 'reserve', entityId: id, action: 'return', detail: { returnedOn: input.returnedOn, classId: input.classId } });

    const row = await q.query<ReserveDbRow>(`${RESERVE_SQL} WHERE r.id = $1`, [id]);
    return { reserve: toView(row.rows[0], today), enrollment: await getEnrollment(q, today, r.enrollment_id) };
  });
}
