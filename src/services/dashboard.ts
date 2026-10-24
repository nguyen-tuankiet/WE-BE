import type { Db } from '../db/types.js';
import { addDays, diffDays, weekdayOf } from '../domain/dates.js';
import type { ProgramGroup } from '../domain/makeup.js';
import { AppError, errors } from '../errors.js';
import type { AuthUser } from '../types.js';
import { isManagement, isTeacherOnly } from './access.js';
import { queryEnrollments, type EnrollmentView } from './enrollments.js';
import { listPendingMakeups } from './makeups.js';
import { getSettings } from './reference.js';

export const GROUP_LABEL: Record<ProgramGroup, string> = {
  baby: 'Baby',
  foundation: 'Kids Foundation',
  cambridge: 'Cambridge',
  ket: 'KET',
  pet: 'PET',
  ielts: 'IELTS',
  communication: 'Giao tiếp',
  grade10: 'Tuyển sinh lớp 10',
};

const isInspector = (user: AuthUser) => user.roles.includes('inspector');

/* ---------- Tổng quan ---------- */

export interface SessionRow {
  date: string;
  class: { id: string; name: string; subject: string; slotId: string; slotLabel: string; slotTime: string; room: string; teacherId: string | null; teacherName: string | null };
  students: number;
  recorded: number;
}

export interface DashboardData {
  /** Chỉ Admin/Manager */
  activeStudents: number | null;
  sessions: SessionRow[];
  periodScheduled: number | null;
  periodRecorded: number | null;
  missingSessions: number | null;
  missingStudents: number | null;
  makeupPending: number | null;
  unpaidCount: number | null;
  unpaidAmount: number | null;
}

/**
 * Số liệu Tổng quan trong khoảng [from, to]: danh sách buổi học (ngày nghỉ tự nhiên không có buổi), điểm danh đã/ cần ghi nhận,
 * buổi thiếu điểm danh; kèm các chỉ số tình trạng hiện tại (không phụ thuộc kỳ). Giáo viên chỉ thấy buổi của lớp mình.
 */
export async function getDashboard(db: Db, user: AuthUser, from: string, to: string, today: string): Promise<DashboardData> {
  if (to < from) throw errors.validation({ to: 'Ngày kết thúc phải sau ngày bắt đầu.' });
  if (diffDays(to, from) > 92) throw errors.validation({ to: 'Chỉ xem tối đa 93 ngày một lần.' });
  const empty: DashboardData = { activeStudents: null, sessions: [], periodScheduled: null, periodRecorded: null, missingSessions: null, missingStudents: null, makeupPending: null, unpaidCount: null, unpaidAmount: null };
  if (isInspector(user) && !isManagement(user.roles) && !user.roles.includes('teacher')) return empty;

  const scoped = isTeacherOnly(user.roles);
  const sessions = await db.query<{
    date: string;
    class_id: string;
    name: string;
    subject: string;
    slot_id: string;
    slot_label: string;
    slot_time: string;
    room: string;
    teacher_id: string | null;
    teacher_name: string | null;
    students: number;
    recorded: number;
  }>(
    `SELECT cs.date::text AS date, c.id::text AS class_id, c.name, c.subject, c.slot_id, sl.label AS slot_label, sl.time_range AS slot_time, c.room,
            c.teacher_id::text AS teacher_id, u.name AS teacher_name, count(*)::int AS students, count(a.id)::int AS recorded
       FROM course_sessions cs
       JOIN enrollments e ON e.id = cs.enrollment_id
       JOIN classes c ON c.id = cs.class_id
       JOIN slots sl ON sl.id = c.slot_id
       LEFT JOIN users u ON u.id = c.teacher_id
       LEFT JOIN attendance a ON a.enrollment_id = cs.enrollment_id AND a.date = cs.date
      WHERE cs.date >= $1::date AND cs.date <= $2::date AND e.status <> 'completed' ${scoped ? 'AND c.teacher_id = $3' : ''}
      GROUP BY cs.date, c.id, sl.sort_order, sl.label, sl.time_range, u.name
      ORDER BY cs.date, sl.sort_order, c.id`,
    scoped ? [from, to, user.id] : [from, to],
  );
  const rows: SessionRow[] = sessions.rows.map((r) => ({
    date: r.date,
    class: { id: r.class_id, name: r.name, subject: r.subject, slotId: r.slot_id, slotLabel: r.slot_label, slotTime: r.slot_time, room: r.room, teacherId: r.teacher_id, teacherName: r.teacher_name },
    students: r.students,
    recorded: r.recorded,
  }));
  if (!isManagement(user.roles)) return { ...empty, sessions: rows };

  const past = rows.filter((r) => r.date <= today);
  const missingEnd = to < today ? to : addDays(today, -1);
  const missing = await db.query<{ n: number; students: number }>(
    `SELECT count(*)::int AS n, count(DISTINCT cs.enrollment_id)::int AS students
       FROM course_sessions cs JOIN enrollments e ON e.id = cs.enrollment_id
       LEFT JOIN attendance a ON a.enrollment_id = cs.enrollment_id AND a.date = cs.date
      WHERE cs.date >= $1::date AND cs.date <= $2::date AND a.id IS NULL AND e.status <> 'completed'`,
    [from, missingEnd],
  );
  const active = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM students WHERE status = 'active'");
  const unpaid = await db.query<{ n: number; amount: string }>("SELECT count(*)::int AS n, coalesce(sum(tuition), 0)::text AS amount FROM enrollments WHERE status = 'active' AND NOT tuition_received");
  const pending = await listPendingMakeups(db, null);
  return {
    activeStudents: active.rows[0].n,
    sessions: rows,
    periodScheduled: past.reduce((n, r) => n + r.students, 0),
    periodRecorded: past.reduce((n, r) => n + r.recorded, 0),
    missingSessions: to < from || missingEnd < from ? 0 : missing.rows[0].n,
    missingStudents: to < from || missingEnd < from ? 0 : missing.rows[0].students,
    makeupPending: pending.length,
    unpaidCount: unpaid.rows[0].n,
    unpaidAmount: Number(unpaid.rows[0].amount),
  };
}

/* ---------- Biểu đồ ---------- */

export interface ChartsData {
  attendanceTrend: { date: string; present: number; late: number; absent: number }[];
  byGroup: { key: string; name: string; value: number }[];
  endingByWeek: { week: string; value: number; from: string; to: string }[];
  ratings: { rating: 'good' | 'average' | 'redflag'; value: number }[];
}

export async function getCharts(db: Db, user: AuthUser, from: string, to: string): Promise<ChartsData> {
  if (to < from) throw errors.validation({ to: 'Ngày kết thúc phải sau ngày bắt đầu.' });
  const manage = isManagement(user.roles);
  const out: ChartsData = { attendanceTrend: [], byGroup: [], endingByWeek: [], ratings: [] };
  if (!manage && !isInspector(user)) return out;

  const ratings = await db.query<{ overall: 'good' | 'average' | 'redflag'; n: number }>('SELECT overall, count(*)::int AS n FROM exam_results GROUP BY overall');
  out.ratings = (['good', 'average', 'redflag'] as const).map((rating) => ({ rating, value: ratings.rows.find((r) => r.overall === rating)?.n ?? 0 }));
  if (!manage) return out;

  const single = from === to;
  const trend = await db.query<{ date: string; present: number; late: number; absent: number }>(
    `SELECT date::text AS date, count(*) FILTER (WHERE status = 'present')::int AS present, count(*) FILTER (WHERE status = 'late')::int AS late,
            count(*) FILTER (WHERE status = 'absent')::int AS absent
       FROM attendance WHERE date <= $1::date ${single ? '' : 'AND date >= $2::date'}
      GROUP BY date ORDER BY date DESC LIMIT ${single ? 14 : 62}`,
    single ? [to] : [to, from],
  );
  out.attendanceTrend = trend.rows.reverse();

  const groups = await db.query<{ grp: ProgramGroup; n: number }>(
    `SELECT p.grp, count(*)::int AS n FROM enrollments e JOIN programs p ON p.id = e.program_id WHERE e.status = 'active' GROUP BY p.grp ORDER BY n DESC, p.grp`,
  );
  out.byGroup = groups.rows.map((g) => ({ key: g.grp, name: GROUP_LABEL[g.grp], value: g.n }));

  const ends = await db.query<{ end_date: string }>(
    `SELECT max(cs.date)::text AS end_date FROM enrollments e JOIN course_sessions cs ON cs.enrollment_id = e.id WHERE e.status = 'active' GROUP BY e.id`,
  );
  const monday = addDays(from, -((weekdayOf(from) + 6) % 7));
  out.endingByWeek = Array.from({ length: 8 }, (_, i) => {
    const start = addDays(monday, i * 7);
    const end = addDays(start, 6);
    return { week: `${start.slice(8, 10)}/${start.slice(5, 7)}`, value: ends.rows.filter((r) => r.end_date >= start && r.end_date <= end).length, from: start, to: end };
  });
  return out;
}

/* ---------- Chi tiết khi bấm vào biểu đồ ---------- */

export async function attendanceDetail(db: Db, date: string, status: 'present' | 'late' | 'absent') {
  const res = await db.query<{ student_id: string; student_name: string; program: string; class_name: string; status: string; notified: boolean; note: string }>(
    `SELECT s.id::text AS student_id, s.name AS student_name, p.name AS program, c.name AS class_name, a.status, a.notified, a.note
       FROM attendance a JOIN enrollments e ON e.id = a.enrollment_id JOIN students s ON s.id = e.student_id JOIN programs p ON p.id = e.program_id JOIN classes c ON c.id = a.class_id
      WHERE a.date = $1::date AND a.status = $2 ORDER BY s.name`,
    [date, status],
  );
  return res.rows.map((r) => ({ studentId: r.student_id, studentName: r.student_name, program: r.program, className: r.class_name, status: r.status, notified: r.notified, note: r.note }));
}

export function groupDetail(db: Db, today: string, group: string): Promise<EnrollmentView[]> {
  if (!(group in GROUP_LABEL)) throw new AppError(400, 'VALIDATION', 'Nhóm chương trình không hợp lệ.');
  return queryEnrollments(db, today, "WHERE e.status = 'active' AND p.grp = $2", [group]);
}

export async function endingDetail(db: Db, today: string, from: string, to: string): Promise<EnrollmentView[]> {
  const rows = await queryEnrollments(db, today, "WHERE e.status = 'active'");
  return rows.filter((r) => r.progress.endDate && r.progress.endDate >= from && r.progress.endDate <= to).sort((a, b) => (a.progress.endDate ?? '').localeCompare(b.progress.endDate ?? ''));
}

/* ---------- Việc cần quan tâm ---------- */

export type TaskType = 'birthday' | 'endcourse' | 'attendance' | 'reserve' | 'exam' | 'tuition';

export interface Task {
  key: string;
  type: TaskType;
  title: string;
  detail: string;
  date: string;
  handled: { by: string; at: string } | null;
}

function nextBirthday(birthday: string, today: string): string {
  const [, m, d] = birthday.split('-');
  let date = `${today.slice(0, 4)}-${m}-${d}`;
  if (date < today) date = `${Number(today.slice(0, 4)) + 1}-${m}-${d}`;
  return date;
}

/**
 * Nhắc việc sinh từ dữ liệu trong cửa sổ `reminderDays` (Cài đặt): sinh nhật, cuối khóa, thiếu điểm danh, bảo lưu sắp hết hạn,
 * kiểm tra chờ chấm, học phí chưa nhận. Nhắc việc chỉ là thông tin cho nhân sự; chưa tự gửi tin cho phụ huynh.
 * Admin/Manager thấy tất cả; Thanh tra chỉ thấy việc kiểm tra; giáo viên không có.
 */
export async function listTasks(db: Db, user: AuthUser, today: string): Promise<Task[]> {
  const manage = isManagement(user.roles);
  if (!manage && !isInspector(user)) return [];
  const settings = await getSettings(db);
  const limit = addDays(today, settings.reminderDays);
  const tasks: Omit<Task, 'handled'>[] = [];

  const plans = await db.query<{ id: string; student_name: string; program: string; units: number; planned_date: string }>(
    `SELECT pl.id::text AS id, s.name AS student_name, p.name AS program, (SELECT count(*)::int FROM exam_plan_units u WHERE u.plan_id = pl.id) AS units, pl.planned_date::text AS planned_date
       FROM exam_plans pl JOIN enrollments e ON e.id = pl.enrollment_id JOIN students s ON s.id = e.student_id JOIN programs p ON p.id = e.program_id
      WHERE pl.status = 'pending'`,
  );
  for (const p of plans.rows) tasks.push({ key: `exam:${p.id}`, type: 'exam', title: p.student_name, detail: `Kiểm tra ${p.units} Unit · ${p.program}`, date: p.planned_date });

  if (manage) {
    const students = await db.query<{ id: string; name: string; birthday: string }>("SELECT id::text AS id, name, birthday::text AS birthday FROM students WHERE status = 'active'");
    for (const s of students.rows) {
      const date = nextBirthday(s.birthday, today);
      if (date <= limit) {
        const age = Number(date.slice(0, 4)) - Number(s.birthday.slice(0, 4));
        tasks.push({ key: `birthday:${s.id}:${date.slice(0, 4)}`, type: 'birthday', title: s.name, detail: `Sinh nhật tròn ${age} tuổi`, date });
      }
    }
    const views = await queryEnrollments(db, today, "WHERE e.status = 'active'");
    const next = await db.query<{ id: string; next_course: string }>("SELECT id::text AS id, next_course FROM students");
    const nextCourse = new Map(next.rows.map((r) => [r.id, r.next_course]));
    for (const v of views) {
      const end = v.progress.endDate;
      if (end && end >= today && end <= limit) {
        tasks.push({ key: `end:${v.id}:${end}`, type: 'endcourse', title: v.student.name, detail: `Sắp hết khóa ${v.program.name} · khóa tiếp: ${nextCourse.get(v.student.id) || 'chưa có'}`, date: end });
      }
      if (v.progress.missing > 0 && v.progress.firstMissingDate) {
        tasks.push({ key: `attn:${v.id}`, type: 'attendance', title: v.student.name, detail: `Thiếu điểm danh ${v.progress.missing} buổi (${v.class.name})`, date: v.progress.firstMissingDate });
      }
      if (!v.tuitionReceived) {
        tasks.push({ key: `tuition:${v.id}`, type: 'tuition', title: v.student.name, detail: `Chưa xác nhận đã nhận học phí ${v.program.name}`, date: v.startDate });
      }
    }
    const reserves = await db.query<{ id: string; student_name: string; expires_on: string }>(
      `SELECT r.id::text AS id, s.name AS student_name, r.expires_on::text AS expires_on FROM reserves r JOIN enrollments e ON e.id = r.enrollment_id JOIN students s ON s.id = e.student_id
        WHERE r.status = 'active' AND r.expires_on <= $1::date`,
      [limit],
    );
    for (const r of reserves.rows) tasks.push({ key: `reserve:${r.id}`, type: 'reserve', title: r.student_name, detail: `Bảo lưu hết hạn ${r.expires_on.split('-').reverse().join('/')}`, date: r.expires_on });
  }

  const handled = await db.query<{ key: string; by: string; at: string }>(
    `SELECT key, handled_by_name AS by, to_char(handled_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM tasks_handled`,
  );
  const map = new Map(handled.rows.map((h) => [h.key, { by: h.by, at: h.at }]));
  return tasks.map((t) => ({ ...t, handled: map.get(t.key) ?? null })).sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

const TASK_KEY = /^(birthday:\d+:\d{4}|end:\d+:\d{4}-\d{2}-\d{2}|attn:\d+|tuition:\d+|reserve:\d+|exam:\d+)$/;

/** Đánh dấu / bỏ đánh dấu "đã xử lý": lưu tài khoản và thời điểm. Chỉ nhận mã việc đúng định dạng. */
export async function markTask(db: Db, user: AuthUser, key: string, done: boolean): Promise<void> {
  if (!TASK_KEY.test(key)) throw errors.validation({ key: 'Mã công việc không hợp lệ.' });
  if (key.startsWith('exam:') ? !(isManagement(user.roles) || isInspector(user)) : !isManagement(user.roles)) throw errors.forbidden();
  if (done) {
    await db.query(
      `INSERT INTO tasks_handled (key, handled_by, handled_by_name) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET handled_by = EXCLUDED.handled_by, handled_by_name = EXCLUDED.handled_by_name, handled_at = now()`,
      [key, user.id, user.name],
    );
  } else {
    await db.query('DELETE FROM tasks_handled WHERE key = $1', [key]);
  }
}
