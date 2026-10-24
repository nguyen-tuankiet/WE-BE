import type { Db, Queryable } from '../db/types.js';
import { AppError, errors } from '../errors.js';
import type { AuthUser } from '../types.js';
import { isTeacherOnly } from './access.js';
import { audit } from './audit.js';

export type MakeupStatus = 'scheduled' | 'done' | 'missed' | 'cancelled';

export interface MakeupView {
  id: string;
  enrollmentId: string;
  student: { id: string; name: string };
  program: { id: string; name: string };
  class: { id: string; name: string };
  absenceDate: string;
  date: string;
  minutes: number;
  room: string;
  status: MakeupStatus;
  notifiedParent: boolean;
  note: string;
  /** Lịch bù đã xếp nhưng không còn khớp (trùng ngày nghỉ, khóa đang bảo lưu, lệch lịch chính…): cần Admin rà soát, hệ thống không tự đổi. */
  needsReview: boolean;
  quota: { maxCount: number; used: number } | null;
}

interface MakeupDbRow {
  id: string;
  enrollment_id: string;
  student_id: string;
  student_name: string;
  program_id: string;
  program_name: string;
  class_id: string;
  class_name: string;
  absence_date: string;
  date: string;
  minutes: number;
  room: string;
  status: MakeupStatus;
  notified_parent: boolean;
  note: string;
  enrollment_status: string;
  makeup_max: number | null;
  used: number;
  end_date: string | null;
  on_session: boolean;
  on_holiday: boolean;
}

const MAKEUP_SQL = `
  SELECT m.id::text AS id, m.enrollment_id::text AS enrollment_id, s.id::text AS student_id, s.name AS student_name,
         p.id AS program_id, p.name AS program_name, c.id::text AS class_id, c.name AS class_name,
         m.absence_date::text AS absence_date, m.date::text AS date, m.minutes, m.room, m.status, m.notified_parent, m.note,
         e.status AS enrollment_status, e.makeup_max,
         (SELECT count(*)::int FROM makeups x WHERE x.enrollment_id = m.enrollment_id AND x.status <> 'cancelled') AS used,
         (SELECT max(cs.date)::text FROM course_sessions cs WHERE cs.enrollment_id = m.enrollment_id) AS end_date,
         EXISTS (SELECT 1 FROM course_sessions cs WHERE cs.enrollment_id = m.enrollment_id AND cs.date = m.date) AS on_session,
         EXISTS (SELECT 1 FROM holidays h WHERE h.date = m.date) AS on_holiday
    FROM makeups m
    JOIN enrollments e ON e.id = m.enrollment_id
    JOIN students s ON s.id = e.student_id
    JOIN programs p ON p.id = e.program_id
    JOIN classes c ON c.id = e.class_id`;

function toView(r: MakeupDbRow): MakeupView {
  const attached = r.minutes === 30; // lượt 30 phút gắn vào buổi chính cuối khóa; lượt 90 phút xếp sau ngày kết thúc
  const drifted = attached ? !r.on_session : r.end_date !== null && r.date <= r.end_date;
  return {
    id: r.id,
    enrollmentId: r.enrollment_id,
    student: { id: r.student_id, name: r.student_name },
    program: { id: r.program_id, name: r.program_name },
    class: { id: r.class_id, name: r.class_name },
    absenceDate: r.absence_date,
    date: r.date,
    minutes: r.minutes,
    room: r.room,
    status: r.status,
    notifiedParent: r.notified_parent,
    note: r.note,
    needsReview: r.status === 'scheduled' && (r.on_holiday || r.enrollment_status !== 'active' || drifted),
    quota: r.makeup_max === null ? null : { maxCount: r.makeup_max, used: r.used },
  };
}

async function queryMakeups(q: Queryable, where: string, params: unknown[]): Promise<MakeupView[]> {
  const res = await q.query<MakeupDbRow>(`${MAKEUP_SQL} ${where} ORDER BY m.date, m.id`, params);
  return res.rows.map(toView);
}

/* ---------- Danh sách + đề xuất ---------- */

export interface PendingMakeup {
  enrollmentId: string;
  student: { id: string; name: string };
  program: { id: string; name: string };
  class: { id: string; name: string };
  absenceDate: string;
  minutes: number;
  quota: { maxCount: number; used: number };
}

/**
 * Buổi vắng ĐÃ BÁO NGHỈ, chưa có lượt bù hiệu lực, và còn trong định mức của khóa → đề xuất xếp bù.
 * Vắng nhiều hơn định mức thì chỉ đề xuất đủ phần còn lại (không mở thêm); nghỉ không báo thì không đủ điều kiện.
 */
export async function listPendingMakeups(q: Queryable, teacherId: string | null): Promise<PendingMakeup[]> {
  const res = await q.query<{
    enrollment_id: string;
    student_id: string;
    student_name: string;
    program_id: string;
    program_name: string;
    class_id: string;
    class_name: string;
    makeup_max: number;
    makeup_minutes: number;
    absence_date: string;
    used: number;
  }>(
    `SELECT e.id::text AS enrollment_id, s.id::text AS student_id, s.name AS student_name, p.id AS program_id, p.name AS program_name,
            c.id::text AS class_id, c.name AS class_name, e.makeup_max, e.makeup_minutes, a.date::text AS absence_date,
            (SELECT count(*)::int FROM makeups x WHERE x.enrollment_id = e.id AND x.status <> 'cancelled') AS used
       FROM attendance a
       JOIN enrollments e ON e.id = a.enrollment_id
       JOIN students s ON s.id = e.student_id
       JOIN programs p ON p.id = e.program_id
       JOIN classes c ON c.id = e.class_id
      WHERE e.status = 'active' AND e.makeup_max IS NOT NULL AND a.status = 'absent' AND a.notified = true
        AND NOT EXISTS (SELECT 1 FROM makeups m WHERE m.enrollment_id = a.enrollment_id AND m.absence_date = a.date AND m.status <> 'cancelled')
        ${teacherId ? 'AND c.teacher_id = $1' : ''}
      ORDER BY e.id, a.date`,
    teacherId ? [teacherId] : [],
  );
  const out: PendingMakeup[] = [];
  const taken = new Map<string, number>();
  for (const r of res.rows) {
    const n = taken.get(r.enrollment_id) ?? 0;
    if (r.used + n >= r.makeup_max) continue;
    taken.set(r.enrollment_id, n + 1);
    out.push({
      enrollmentId: r.enrollment_id,
      student: { id: r.student_id, name: r.student_name },
      program: { id: r.program_id, name: r.program_name },
      class: { id: r.class_id, name: r.class_name },
      absenceDate: r.absence_date,
      minutes: r.makeup_minutes,
      quota: { maxCount: r.makeup_max, used: r.used },
    });
  }
  return out;
}

/** Admin/Manager xem tất cả; giáo viên chỉ xem lượt bù của lớp mình (docs/01: "xem phần được cấp"). */
export async function listMakeups(db: Db, user: AuthUser): Promise<{ list: MakeupView[]; pending: PendingMakeup[] }> {
  const scoped = isTeacherOnly(user.roles);
  const list = await queryMakeups(db, scoped ? 'WHERE c.teacher_id = $1' : '', scoped ? [user.id] : []);
  return { list, pending: await listPendingMakeups(db, scoped ? user.id : null) };
}

/* ---------- Xếp bù ---------- */

export interface NewMakeup {
  enrollmentId: string;
  absenceDate: string;
  date: string;
  room: string;
  notifiedParent: boolean;
  note: string;
}

export async function createMakeup(db: Db, user: AuthUser, input: NewMakeup): Promise<MakeupView> {
  return db.tx(async (q) => {
    const enr = await q.query<{ status: string; makeup_max: number | null; makeup_minutes: number | null }>(
      'SELECT status, makeup_max, makeup_minutes FROM enrollments WHERE id = $1 FOR UPDATE',
      [input.enrollmentId],
    );
    if (enr.rowCount === 0) throw errors.notFound('Khóa đăng ký');
    const e = enr.rows[0];
    if (e.status !== 'active') throw new AppError(422, 'ENROLLMENT_NOT_ACTIVE', 'Khóa không còn đang học nên chưa thể xếp bù.');
    if (e.makeup_max === null || e.makeup_minutes === null) {
      throw new AppError(422, 'NO_MAKEUP_POLICY', 'Chương trình này chưa có chính sách học bù. Admin cần xác nhận trước.');
    }

    const absence = await q.query<{ status: string; notified: boolean }>('SELECT status, notified FROM attendance WHERE enrollment_id = $1 AND date = $2::date', [
      input.enrollmentId,
      input.absenceDate,
    ]);
    if (absence.rowCount === 0 || absence.rows[0].status !== 'absent') {
      throw new AppError(422, 'NOT_ABSENT', 'Ngày này không có buổi vắng được ghi nhận của khóa.');
    }
    if (!absence.rows[0].notified) {
      throw new AppError(422, 'MAKEUP_NOT_NOTIFIED', 'Buổi nghỉ không thông báo thì không xếp học bù miễn phí.');
    }
    const dup = await q.query("SELECT 1 FROM makeups WHERE enrollment_id = $1 AND absence_date = $2::date AND status <> 'cancelled'", [input.enrollmentId, input.absenceDate]);
    if (dup.rowCount > 0) throw new AppError(409, 'MAKEUP_EXISTS', 'Buổi vắng này đã có lượt bù.');

    const used = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM makeups WHERE enrollment_id = $1 AND status <> 'cancelled'", [input.enrollmentId]);
    if (used.rows[0].n >= e.makeup_max) {
      throw new AppError(422, 'MAKEUP_LIMIT_EXCEEDED', `Đã dùng hết ${e.makeup_max} lượt bù của khóa. Không xếp thêm ngoài giới hạn.`);
    }

    if (input.date <= input.absenceDate) throw new AppError(422, 'MAKEUP_DATE_INVALID', 'Ngày bù phải sau buổi vắng.');
    const holiday = await q.query('SELECT 1 FROM holidays WHERE date = $1::date', [input.date]);
    if (holiday.rowCount > 0) throw new AppError(422, 'MAKEUP_ON_HOLIDAY', 'Ngày bù trùng ngày trung tâm nghỉ.');
    const room = await q.query('SELECT 1 FROM rooms WHERE id = $1', [input.room]);
    if (room.rowCount === 0) throw errors.validation({ room: 'Phòng không tồn tại.' });
    const sameDay = await q.query("SELECT 1 FROM makeups WHERE enrollment_id = $1 AND date = $2::date AND status <> 'cancelled'", [input.enrollmentId, input.date]);
    if (sameDay.rowCount > 0) throw new AppError(409, 'MAKEUP_DATE_TAKEN', 'Khóa này đã có lượt bù khác vào ngày này.');

    const sessions = await q.query<{ date: string }>('SELECT date::text AS date FROM course_sessions WHERE enrollment_id = $1 ORDER BY date', [input.enrollmentId]);
    const dates = sessions.rows.map((r) => r.date);
    if (e.makeup_minutes === 30) {
      const allowed = dates.slice(-e.makeup_max);
      if (!allowed.includes(input.date)) {
        throw new AppError(422, 'MAKEUP_DATE_INVALID', `Buổi bù 30 phút gắn vào ${e.makeup_max} buổi chính cuối khóa (${allowed.join(', ')}).`);
      }
    } else if (dates.length > 0 && input.date <= dates[dates.length - 1]) {
      throw new AppError(422, 'MAKEUP_DATE_INVALID', `Buổi bù thực hiện sau ngày kết thúc buổi chính (${dates[dates.length - 1]}).`);
    }

    const created = await q.query<{ id: string }>(
      `INSERT INTO makeups (enrollment_id, absence_date, date, minutes, room, notified_parent, note, created_by, updated_by)
       VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $8) RETURNING id::text AS id`,
      [input.enrollmentId, input.absenceDate, input.date, e.makeup_minutes, input.room, input.notifiedParent, input.note.trim(), user.id],
    );
    const id = created.rows[0].id;
    await audit(q, {
      userId: user.id,
      entity: 'makeup',
      entityId: id,
      action: 'create',
      detail: { enrollmentId: input.enrollmentId, absenceDate: input.absenceDate, date: input.date, minutes: e.makeup_minutes },
    });
    return (await queryMakeups(q, 'WHERE m.id = $1', [id]))[0];
  });
}

/* ---------- Vòng đời ---------- */

/**
 * Scheduled → Hoàn tất | Vắng bù | Đã hủy. Hoàn tất ≠ Vắng bù: Vắng bù là đã mất lượt (vẫn tính đã dùng, không xếp lại).
 * Chỉ ghi kết quả khi ngày bù đã tới. Hủy cần lý do; lượt đã hủy tạm không tính vào định mức (docs/08 #4 chờ chốt).
 */
export async function setMakeupStatus(db: Db, user: AuthUser, id: string, status: Exclude<MakeupStatus, 'scheduled'>, note: string, today: string): Promise<MakeupView> {
  return db.tx(async (q) => {
    const cur = await q.query<{ status: MakeupStatus; date: string }>('SELECT status, date::text AS date FROM makeups WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) throw errors.notFound('Lượt bù');
    if (cur.rows[0].status !== 'scheduled') {
      throw new AppError(422, 'INVALID_TRANSITION', 'Lượt bù này đã có kết quả cuối cùng, không đổi trạng thái được nữa.');
    }
    if (status === 'cancelled' && !note.trim()) throw errors.validation({ note: 'Hủy lịch bù cần ghi lý do.' });
    if ((status === 'done' || status === 'missed') && cur.rows[0].date > today) {
      throw new AppError(422, 'MAKEUP_NOT_YET', 'Chưa tới ngày bù, chưa thể ghi nhận kết quả.');
    }
    await q.query("UPDATE makeups SET status = $2, note = CASE WHEN $3 = '' THEN note ELSE $3 END, updated_by = $4, updated_at = now() WHERE id = $1", [
      id,
      status,
      note.trim(),
      user.id,
    ]);
    await audit(q, { userId: user.id, entity: 'makeup', entityId: id, action: status, detail: { from: 'scheduled', to: status, note: note.trim() } });
    return (await queryMakeups(q, 'WHERE m.id = $1', [id]))[0];
  });
}
