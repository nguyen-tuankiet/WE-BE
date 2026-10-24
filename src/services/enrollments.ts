import type { Db, Queryable } from '../db/types.js';
import { makeupQuota, type MakeupQuota, type ProgramGroup } from '../domain/makeup.js';
import { generateSchedule } from '../domain/schedule.js';
import { AppError, errors } from '../errors.js';
import { audit } from './audit.js';

export interface EnrollmentView {
  id: string;
  student: { id: string; code: string; name: string; status: string };
  program: { id: string; name: string; group: string };
  class: { id: string; name: string };
  startDate: string;
  weekdays: number[];
  totalSessions: number;
  tuition: number;
  tuitionReceived: boolean;
  status: string;
  note: string;
  makeupQuota: MakeupQuota | null;
  /** Số lượt bù đã dùng (không tính lượt đã hủy) */
  makeupUsed: number;
  progress: {
    total: number;
    /** Số buổi theo lịch đã diễn ra (tính đến hôm nay) */
    held: number;
    remaining: number;
    endDate: string | null;
    /** Số buổi đã có điểm danh */
    recorded: number;
    /** Buổi đã qua nhưng chưa ghi nhận — hiển thị "Chưa ghi nhận", không suy đoán */
    missing: number;
    firstMissingDate: string | null;
  };
}

interface ViewRow {
  id: string;
  student_id: string;
  student_code: string;
  student_name: string;
  student_status: string;
  program_id: string;
  program_name: string;
  grp: string;
  class_id: string;
  class_name: string;
  start_date: string;
  total_sessions: number;
  tuition: string;
  tuition_received: boolean;
  makeup_max: number | null;
  makeup_minutes: number | null;
  makeup_used: number;
  status: string;
  note: string;
  weekdays: number[] | null;
  total: number;
  held: number;
  end_date: string | null;
  recorded: number;
  missing: number;
  first_missing: string | null;
}

const VIEW_SQL = `
  SELECT e.id::text AS id, e.student_id::text AS student_id, s.code AS student_code, s.name AS student_name, s.status AS student_status,
         e.program_id, p.name AS program_name, p.grp, e.class_id::text AS class_id, c.name AS class_name,
         e.start_date::text AS start_date, e.total_sessions, e.tuition::text AS tuition, e.tuition_received,
         e.makeup_max, e.makeup_minutes, e.status, e.note,
         (SELECT count(*)::int FROM makeups m WHERE m.enrollment_id = e.id AND m.status <> 'cancelled') AS makeup_used,
         (SELECT es.weekdays::int[] FROM enrollment_schedule es WHERE es.enrollment_id = e.id ORDER BY es.effective_from DESC LIMIT 1) AS weekdays,
         count(cs.id)::int AS total,
         count(cs.id) FILTER (WHERE cs.date <= $1::date)::int AS held,
         max(cs.date)::text AS end_date,
         count(a.id)::int AS recorded,
         count(cs.id) FILTER (WHERE cs.date < $1::date AND a.id IS NULL)::int AS missing,
         min(cs.date) FILTER (WHERE cs.date < $1::date AND a.id IS NULL)::text AS first_missing
    FROM enrollments e
    JOIN students s ON s.id = e.student_id
    JOIN programs p ON p.id = e.program_id
    JOIN classes c ON c.id = e.class_id
    LEFT JOIN course_sessions cs ON cs.enrollment_id = e.id
    LEFT JOIN attendance a ON a.enrollment_id = cs.enrollment_id AND a.date = cs.date`;

function toView(r: ViewRow): EnrollmentView {
  return {
    id: r.id,
    student: { id: r.student_id, code: r.student_code, name: r.student_name, status: r.student_status },
    program: { id: r.program_id, name: r.program_name, group: r.grp },
    class: { id: r.class_id, name: r.class_name },
    startDate: r.start_date,
    weekdays: r.weekdays ?? [],
    totalSessions: r.total_sessions,
    tuition: Number(r.tuition),
    tuitionReceived: r.tuition_received,
    status: r.status,
    note: r.note,
    makeupQuota: r.makeup_max !== null && r.makeup_minutes !== null ? { maxCount: r.makeup_max, minutes: r.makeup_minutes } : null,
    makeupUsed: r.makeup_used,
    progress: {
      total: r.total,
      held: r.held,
      remaining: r.total - r.held,
      endDate: r.end_date,
      recorded: r.recorded,
      missing: r.missing,
      firstMissingDate: r.first_missing,
    },
  };
}

/** Truy vấn khóa đăng ký kèm tiến độ tính từ lịch buổi học. `where` là điều kiện SQL cố định, tham số bắt đầu từ $2. */
export async function queryEnrollments(q: Queryable, today: string, where = '', params: unknown[] = []): Promise<EnrollmentView[]> {
  const res = await q.query<ViewRow>(
    `${VIEW_SQL} ${where} GROUP BY e.id, s.id, p.id, c.id ORDER BY e.id`,
    [today, ...params],
  );
  return res.rows.map(toView);
}

export const listEnrollments = (db: Db, today: string) => queryEnrollments(db, today);

export async function getEnrollment(q: Queryable, today: string, id: string): Promise<EnrollmentView> {
  const rows = await queryEnrollments(q, today, 'WHERE e.id = $2', [id]);
  if (rows.length === 0) throw errors.notFound('Khóa đăng ký');
  return rows[0];
}

/* ---------- Sinh lại lịch buổi chính ---------- */

async function holidayDates(q: Queryable): Promise<string[]> {
  const res = await q.query<{ date: string }>('SELECT date::text AS date FROM holidays');
  return res.rows.map((r) => r.date);
}

export interface SessionRow {
  date: string;
  classId: string;
}

async function insertSessions(q: Queryable, enrollmentId: string, firstSeq: number, rows: SessionRow[]) {
  if (rows.length === 0) return;
  await q.query(
    `INSERT INTO course_sessions (enrollment_id, seq, date, class_id)
     SELECT $1::bigint, s.seq, s.d::date, s.c::bigint FROM unnest($2::int[], $3::text[], $4::text[]) AS s(seq, d, c)`,
    [enrollmentId, rows.map((_, i) => firstSeq + i), rows.map((r) => r.date), rows.map((r) => r.classId)],
  );
}

/** Khoảng bảo lưu đã kết thúc (đã nhập học lại): lịch chính tạm dừng trong khoảng này. Bảo lưu đang hiệu lực thì khóa không được sinh lại lịch. */
async function pausedRanges(q: Queryable, enrollmentId: string): Promise<{ from: string; to: string }[]> {
  const res = await q.query<{ from: string; to: string }>(
    `SELECT completed_on::text AS "from", (returned_on - 1)::text AS "to" FROM reserves WHERE enrollment_id = $1 AND status = 'returned' AND returned_on IS NOT NULL`,
    [enrollmentId],
  );
  return res.rows;
}

const HAS_ATTENDANCE = 'EXISTS (SELECT 1 FROM attendance a WHERE a.enrollment_id = cs.enrollment_id AND a.date = cs.date)';

/**
 * Sinh lại các buổi từ ngày `from` trở đi cho một khóa. Buổi trước `from` và MỌI buổi đã có điểm danh được giữ nguyên
 * (không bao giờ dời buổi đã ghi nhận); phần còn lại được sinh lại cho đủ định mức, bỏ qua ngày trung tâm nghỉ.
 * Ngày nghỉ KHÔNG tạo buổi vắng và không làm mất lượt bù.
 */
export async function regenerateFrom(q: Queryable, enrollmentId: string, from: string): Promise<void> {
  const enr = await q.query<{ total_sessions: number; start_date: string }>(
    'SELECT total_sessions, start_date::text AS start_date FROM enrollments WHERE id = $1 FOR UPDATE',
    [enrollmentId],
  );
  const segs = await q.query<{ effective_from: string; class_id: string; weekdays: number[] }>(
    'SELECT effective_from::text AS effective_from, class_id::text AS class_id, weekdays::int[] AS weekdays FROM enrollment_schedule WHERE enrollment_id = $1 ORDER BY effective_from',
    [enrollmentId],
  );
  if (enr.rowCount === 0 || segs.rowCount === 0) return;
  const { total_sessions: total, start_date: start } = enr.rows[0];

  await q.query(`DELETE FROM course_sessions cs WHERE cs.enrollment_id = $1 AND cs.date >= $2::date AND NOT ${HAS_ATTENDANCE}`, [enrollmentId, from]);
  const kept = await q.query<{ date: string }>('SELECT date::text AS date FROM course_sessions WHERE enrollment_id = $1', [enrollmentId]);
  const keptDates = kept.rows.map((r) => r.date);

  const segments = segs.rows.map((r) => ({ from: r.effective_from, weekdays: r.weekdays }));
  const classOn = (date: string) => {
    let cls = segs.rows[0].class_id;
    for (const sg of segs.rows) if (sg.effective_from <= date) cls = sg.class_id;
    return cls;
  };
  const dates = generateSchedule({
    startDate: from > start ? from : start,
    weekdays: [],
    segments,
    totalSessions: Math.max(total - keptDates.length, 0),
    closedDates: [...(await holidayDates(q)), ...keptDates],
    pausedRanges: await pausedRanges(q, enrollmentId),
  });
  // Số thứ tự tạm lớn để không trùng; ngay sau đó đánh lại 1..n theo ngày.
  await insertSessions(q, enrollmentId, 1_000_000, dates.map((date) => ({ date, classId: classOn(date) })));
  await renumberSessions(q, enrollmentId);
}

/** Đánh lại số thứ tự buổi 1..n theo ngày. Hai bước vì ràng buộc duy nhất kiểm tra ngay từng dòng. */
async function renumberSessions(q: Queryable, enrollmentId: string) {
  await q.query('UPDATE course_sessions SET seq = -id WHERE enrollment_id = $1', [enrollmentId]);
  await q.query(
    `UPDATE course_sessions cs SET seq = r.rn
       FROM (SELECT id, row_number() OVER (ORDER BY date)::int AS rn FROM course_sessions WHERE enrollment_id = $1) r
      WHERE cs.id = r.id AND cs.enrollment_id = $1`,
    [enrollmentId],
  );
}

/** Dời lịch của mọi khóa đang học có buổi từ ngày `from` trở đi (dùng khi thêm/xóa ngày nghỉ). Trả về số khóa bị ảnh hưởng. */
export async function rescheduleFrom(q: Queryable, from: string): Promise<number> {
  const res = await q.query<{ id: string }>(
    `SELECT DISTINCT e.id::text AS id FROM enrollments e JOIN course_sessions cs ON cs.enrollment_id = e.id
      WHERE e.status = 'active' AND cs.date >= $1::date ORDER BY 1`,
    [from],
  );
  for (const row of res.rows) await regenerateFrom(q, row.id, from);
  return res.rowCount;
}

/* ---------- Tạo khóa đăng ký ---------- */

export interface NewEnrollment {
  studentId: string;
  programId: string;
  classId: string;
  startDate: string;
  weekdays?: number[];
  totalSessions?: number;
  tuition?: number;
  tuitionReceived?: boolean;
  note?: string;
}

/**
 * Tạo khóa: chụp học phí + định mức bù từ danh mục, sinh toàn bộ buổi chính theo ngày bắt đầu và ngày học của lớp.
 * Mọi thứ trong một giao dịch — lỗi ở bước nào thì không lưu dở.
 */
export async function createEnrollment(db: Db, today: string, input: NewEnrollment, actorId: string): Promise<EnrollmentView> {
  return db.tx(async (q) => {
    const student = await q.query<{ status: string }>('SELECT status FROM students WHERE id = $1', [input.studentId]);
    if (student.rowCount === 0) throw errors.notFound('Học viên');
    if (student.rows[0].status === 'left') throw new AppError(422, 'STUDENT_LEFT', 'Học viên đã nghỉ, không thể đăng ký khóa mới.');

    const program = await q.query<{ grp: ProgramGroup; tuition: string; sessions_count: number | null; active: boolean }>(
      'SELECT grp, tuition::text AS tuition, sessions_count, active FROM programs WHERE id = $1',
      [input.programId],
    );
    if (program.rowCount === 0) throw errors.notFound('Chương trình');
    const p = program.rows[0];
    if (!p.active) throw new AppError(422, 'PROGRAM_INACTIVE', 'Chương trình này đã ngừng đăng ký.');

    const cls = await q.query<{ active: boolean; max_size: number }>('SELECT active, max_size FROM classes WHERE id = $1 FOR UPDATE', [input.classId]);
    if (cls.rowCount === 0) throw errors.notFound('Lớp');
    if (!cls.rows[0].active) throw new AppError(422, 'CLASS_INACTIVE', 'Lớp đã ngừng hoạt động.');
    const taken = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM enrollments WHERE class_id = $1 AND status = 'active'", [input.classId]);
    if (taken.rows[0].n >= cls.rows[0].max_size) throw new AppError(422, 'CLASS_FULL', 'Lớp đã đủ sĩ số tối đa.');

    let weekdays = input.weekdays;
    if (!weekdays) {
      const w = await q.query<{ weekday: number }>('SELECT weekday::int AS weekday FROM class_weekdays WHERE class_id = $1 ORDER BY weekday', [input.classId]);
      weekdays = w.rows.map((r) => r.weekday);
    }
    if (weekdays.length === 0) throw new AppError(422, 'NO_WEEKDAYS', 'Lớp chưa có ngày học. Hãy cấu hình ngày học của lớp hoặc nhập ngày học cho khóa.');

    const total = input.totalSessions ?? p.sessions_count;
    if (!total) {
      throw new AppError(422, 'SESSIONS_REQUIRED', 'Gói này tính theo tháng: Admin cần xác nhận số buổi thực tế trước khi đăng ký.');
    }

    const dates = generateSchedule({ startDate: input.startDate, weekdays, totalSessions: total, closedDates: await holidayDates(q) });
    if (dates.length < total) throw new AppError(422, 'SCHEDULE_FAILED', 'Không sinh đủ lịch buổi học từ ngày bắt đầu.');

    const quota = makeupQuota(p.grp);
    const created = await q.query<{ id: string }>(
      `INSERT INTO enrollments (student_id, program_id, class_id, start_date, total_sessions, tuition, tuition_received, makeup_max, makeup_minutes, note)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10) RETURNING id::text AS id`,
      [
        input.studentId,
        input.programId,
        input.classId,
        input.startDate,
        total,
        input.tuition ?? Number(p.tuition),
        input.tuitionReceived ?? false,
        quota?.maxCount ?? null,
        quota?.minutes ?? null,
        input.note ?? '',
      ],
    );
    const id = created.rows[0].id;
    await q.query('INSERT INTO enrollment_schedule (enrollment_id, effective_from, class_id, weekdays) VALUES ($1, $2::date, $3, $4::smallint[])', [
      id,
      input.startDate,
      input.classId,
      weekdays,
    ]);
    await insertSessions(q, id, 1, dates.map((date) => ({ date, classId: input.classId })));
    await audit(q, {
      userId: actorId,
      entity: 'enrollment',
      entityId: id,
      action: 'create',
      detail: { studentId: input.studentId, programId: input.programId, classId: input.classId, startDate: input.startDate, total, endDate: dates[dates.length - 1] },
    });
    return getEnrollment(q, today, id);
  });
}


/* ---------- Chuyển lớp giữa khóa ---------- */

export interface TransferInput {
  toClassId: string;
  effectiveDate: string;
  weekdays?: number[];
  note?: string;
}

/**
 * Chuyển lớp, giữ nguyên quyền học còn lại (không tạo khóa mới): các buổi trước ngày hiệu lực và mọi buổi đã điểm danh
 * vẫn thuộc lớp cũ; các buổi sau đó được lập lại theo ngày học của lớp mới, vẫn đủ định mức.
 */
export async function transferEnrollment(
  db: Db,
  today: string,
  id: string,
  input: TransferInput,
  actorId: string,
): Promise<{ enrollment: EnrollmentView; transfer: { fromClassId: string; toClassId: string; effectiveDate: string; remainingSessions: number }; scheduledMakeupsToReview: number }> {
  return db.tx(async (q) => {
    const enr = await q.query<{ class_id: string; status: string; start_date: string }>(
      'SELECT class_id::text AS class_id, status, start_date::text AS start_date FROM enrollments WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (enr.rowCount === 0) throw errors.notFound('Khóa đăng ký');
    const cur = enr.rows[0];
    if (cur.status !== 'active') throw new AppError(422, 'ENROLLMENT_NOT_ACTIVE', 'Chỉ chuyển lớp cho khóa đang học (khóa đang bảo lưu thì chọn lớp khi nhập học lại).');
    if (cur.class_id === input.toClassId) throw new AppError(422, 'SAME_CLASS', 'Học viên đang học lớp này rồi.');
    if (input.effectiveDate < today) {
      throw new AppError(422, 'TRANSFER_IN_PAST', 'Ngày hiệu lực chuyển lớp phải từ hôm nay trở đi (các buổi đã qua giữ nguyên ở lớp cũ).');
    }

    const cls = await q.query<{ active: boolean; max_size: number }>('SELECT active, max_size FROM classes WHERE id = $1 FOR UPDATE', [input.toClassId]);
    if (cls.rowCount === 0) throw errors.notFound('Lớp');
    if (!cls.rows[0].active) throw new AppError(422, 'CLASS_INACTIVE', 'Lớp đã ngừng hoạt động.');
    const taken = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM enrollments WHERE class_id = $1 AND status = 'active'", [input.toClassId]);
    if (taken.rows[0].n >= cls.rows[0].max_size) throw new AppError(422, 'CLASS_FULL', 'Lớp đến đã đủ sĩ số tối đa.');

    let weekdays = input.weekdays;
    if (!weekdays) {
      const w = await q.query<{ weekday: number }>('SELECT weekday::int AS weekday FROM class_weekdays WHERE class_id = $1 ORDER BY weekday', [input.toClassId]);
      weekdays = w.rows.map((r) => r.weekday);
    }
    if (weekdays.length === 0) throw new AppError(422, 'NO_WEEKDAYS', 'Lớp đến chưa có ngày học.');

    const remaining = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM course_sessions cs WHERE cs.enrollment_id = $1 AND cs.date >= $2::date AND NOT ${HAS_ATTENDANCE}`,
      [id, input.effectiveDate],
    );

    await q.query(
      `INSERT INTO enrollment_schedule (enrollment_id, effective_from, class_id, weekdays) VALUES ($1, $2::date, $3, $4::smallint[])
       ON CONFLICT (enrollment_id, effective_from) DO UPDATE SET class_id = EXCLUDED.class_id, weekdays = EXCLUDED.weekdays`,
      [id, input.effectiveDate, input.toClassId, weekdays],
    );
    await q.query('UPDATE enrollments SET class_id = $2, updated_at = now() WHERE id = $1', [id, input.toClassId]);
    await regenerateFrom(q, id, input.effectiveDate);
    await q.query(
      `INSERT INTO transfers (enrollment_id, from_class_id, to_class_id, effective_date, remaining_sessions, note, created_by)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7)`,
      [id, cur.class_id, input.toClassId, input.effectiveDate, remaining.rows[0].n, (input.note ?? '').trim(), actorId],
    );
    const review = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM makeups WHERE enrollment_id = $1 AND status = 'scheduled'", [id]);
    await audit(q, {
      userId: actorId,
      entity: 'enrollment',
      entityId: id,
      action: 'transfer',
      detail: { from: cur.class_id, to: input.toClassId, effectiveDate: input.effectiveDate, remaining: remaining.rows[0].n },
    });
    return {
      enrollment: await getEnrollment(q, today, id),
      transfer: { fromClassId: cur.class_id, toClassId: input.toClassId, effectiveDate: input.effectiveDate, remainingSessions: remaining.rows[0].n },
      scheduledMakeupsToReview: review.rows[0].n,
    };
  });
}
