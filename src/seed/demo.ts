import type { Db } from '../db/types.js';

/**
 * Dữ liệu DEMO để chạy thử trọn vòng giao diện + API khi chưa có Neon.
 * Toàn bộ tên là GIẢ (không phải học viên/nhân sự thật). KHÔNG chạy trên cơ sở dữ liệu thật.
 * Đi qua chính API (cùng validate/nghiệp vụ như người dùng thao tác), không ghi thẳng vào bảng.
 */
export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>;

export const DEMO_PIN = '123456';
export const DEMO_ACCOUNTS = [
  { email: 'admin@we.vn', name: 'Quản trị viên', roles: ['admin'] },
  { email: 'quanly@we.vn', name: 'Quản lý Demo', roles: ['manager'], birthday: '1988-03-12' },
  { email: 'gv.lan@we.vn', name: 'Cô Lan (GV)', roles: ['teacher'], birthday: '1992-07-21' },
  { email: 'gv.minh@we.vn', name: 'Thầy Minh (GV)', roles: ['teacher'], birthday: '1990-11-05' },
  { email: 'thanhtra@we.vn', name: 'Thanh tra Demo', roles: ['inspector'], birthday: '1985-01-30' },
];

const NAMES = [
  'Nguyễn Gia An', 'Trần Bảo Châu', 'Lê Minh Khôi', 'Phạm Hà My', 'Hoàng Đức Anh', 'Vũ Khánh Linh',
  'Đặng Quốc Bảo', 'Bùi Thảo Nguyên', 'Ngô Anh Thư', 'Đỗ Tuấn Kiệt', 'Dương Mai Anh', 'Lý Hoàng Nam',
  'Phan Ngọc Hân', 'Võ Gia Huy', 'Huỳnh Thanh Vy', 'Mai Đình Phúc', 'Trịnh Bích Ngọc', 'Tạ Minh Quân',
  'Cao Thiên Ân', 'Lương Diệp Chi', 'Kiều Bảo Long', 'Đinh Hải Yến', 'Thái Nhật Minh', 'Châu Phương Thảo',
];
const GUARDIANS = ['Chị Hương', 'Anh Tùng', 'Cô Thu', 'Chị Mai', 'Anh Hải', 'Chị Ngân'];

async function must(call: Call, method: string, path: string, body?: unknown) {
  const res = await call(method, path, body);
  if (res.status >= 300) throw new Error(`Dữ liệu demo lỗi: ${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function soft(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.warn(`[demo] bỏ qua "${label}": ${(e as Error).message}`);
  }
}

/** `call` đã đăng nhập Admin. `today` = ngày giả lập của máy chủ dev. */
export async function seedDemo(db: Db, call: Call, today: string) {
  for (const a of DEMO_ACCOUNTS.filter((x) => x.email !== 'admin@we.vn')) await must(call, 'POST', '/api/v1/staff', { ...a, pin: DEMO_PIN });
  const staff = (await must(call, 'GET', '/api/v1/staff')).staff as { id: string; email: string }[];
  const id = (email: string) => staff.find((s) => s.email === email)!.id;

  await soft('ngày nghỉ', () => must(call, 'POST', '/api/v1/holidays', { date: '2026-11-20', reason: 'Ngày Nhà giáo Việt Nam' }));

  const defs = [
    { name: 'Explorers 1 – T2/4/6 tối 1', slotId: 'toi1', room: '101', teacher: 'gv.lan@we.vn', weekdays: [1, 3, 5], program: 'smart-explorers-1' },
    { name: 'Starters Nền tảng – T2/4/6 tối 2', slotId: 'toi2', room: '102', teacher: 'gv.minh@we.vn', weekdays: [1, 3, 5], program: 'starters-nen-tang' },
    { name: 'Achievers 1 – T3/5 tối 1', slotId: 'toi1', room: '101', teacher: 'gv.lan@we.vn', weekdays: [2, 4], program: 'smart-achievers-1' },
    { name: 'Explorers 1 – T3/5 tối 2', slotId: 'toi2', room: '103', teacher: 'gv.minh@we.vn', weekdays: [2, 4], program: 'smart-explorers-1' },
  ];
  const enrollments: { id: string; studentId: string; classId: string; program: string; start: string }[] = [];
  let n = 0;
  for (const d of defs) {
    const cls = (await must(call, 'POST', '/api/v1/classes', { name: d.name, slotId: d.slotId, room: d.room, teacherId: id(d.teacher), weekdays: d.weekdays })).class;
    for (let i = 0; i < 6; i++, n++) {
      const year = 2015 + (n % 5);
      const month = ((n * 5) % 12) + 1;
      const birthday = n === 0 ? '2016-10-25' : `${year}-${String(month).padStart(2, '0')}-${String(((n * 7) % 27) + 1).padStart(2, '0')}`;
      const s = (await must(call, 'POST', '/api/v1/students', {
        name: NAMES[n], birthday, guardian: GUARDIANS[n % GUARDIANS.length], phone: `09${String(10000000 + n * 137).padStart(8, '0')}`, address: 'TP. Hồ Chí Minh', tuitionMode: n % 2 ? 'Đóng theo tháng' : 'Đóng theo khóa',
      })).student;
      const start = new Date(Date.UTC(2026, 8, 7 + (n % 4) * 7));
      const startDate = start.toISOString().slice(0, 10);
      const e = (await must(call, 'POST', '/api/v1/enrollments', { studentId: s.id, programId: d.program, classId: cls.id, startDate, tuitionReceived: n % 7 !== 3 })).enrollment;
      enrollments.push({ id: e.id, studentId: s.id, classId: cls.id, program: d.program, start: startDate });
    }
  }

  // Điểm danh toàn bộ buổi đã qua (trước hôm nay) trừ vài buổi gần nhất của lớp cuối để còn "Chưa ghi nhận"
  const past = await db.query<{ class_id: string; date: string; enrollment_id: string }>(
    `SELECT class_id::text AS class_id, date::text AS date, enrollment_id::text AS enrollment_id FROM course_sessions WHERE date < $1::date ORDER BY date, class_id`,
    [today],
  );
  const lastClass = enrollments[enrollments.length - 1].classId;
  const groups = new Map<string, { classId: string; date: string; ids: string[] }>();
  for (const r of past.rows) {
    const k = `${r.class_id}|${r.date}`;
    if (!groups.has(k)) groups.set(k, { classId: r.class_id, date: r.date, ids: [] });
    groups.get(k)!.ids.push(r.enrollment_id);
  }
  let h = 7;
  for (const g of groups.values()) {
    if (g.classId === lastClass && g.date >= '2026-10-19') continue;
    const items = g.ids.map((enrollmentId) => {
      h = (h * 31 + Number(enrollmentId) * 17 + Number(g.date.slice(8))) % 97;
      const status = h < 8 ? 'absent' : h < 14 ? 'late' : 'present';
      return { enrollmentId, status, notified: status === 'absent' && h % 2 === 0 };
    });
    await must(call, 'PUT', '/api/v1/attendance', { classId: g.classId, date: g.date, items });
  }

  // Học bù: một buổi vắng có báo trước được xếp lịch
  await soft('học bù', async () => {
    // Buổi bù 30' gắn vào các buổi chính cuối khóa; 90' diễn ra sau ngày kết thúc (docs/02)
    const abs = await db.query<{ enrollment_id: string; date: string; minutes: number; last: string }>(
      `SELECT a.enrollment_id::text AS enrollment_id, a.date::text AS date, e.makeup_minutes AS minutes,
              (SELECT max(date)::text FROM course_sessions s WHERE s.enrollment_id = a.enrollment_id) AS last
         FROM attendance a JOIN enrollments e ON e.id = a.enrollment_id
        WHERE a.status = 'absent' AND a.notified ORDER BY a.date DESC`,
    );
    const seen = new Set<string>();
    for (const a of abs.rows) {
      if (seen.size >= 3 || seen.has(a.enrollment_id)) continue;
      seen.add(a.enrollment_id);
      const date = a.minutes === 30 ? a.last : new Date(Date.parse(`${a.last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      await soft(`học bù ${a.enrollment_id}`, () => must(call, 'POST', '/api/v1/makeups', { enrollmentId: a.enrollment_id, absenceDate: a.date, date, room: '202', notifiedParent: true }));
    }
  });

  // Bảo lưu: một khóa
  await soft('bảo lưu', () =>
    must(call, 'POST', '/api/v1/reserves', { enrollmentId: enrollments[5].id, noticeAt: `${today}T09:00`, completedOn: '2026-10-27', absentStreak: 10, amount: 1_500_000, note: 'Gia đình đi xa (demo)' }),
  );

  // Khung nội dung MẪU + lịch kiểm tra + một phiếu đã chấm
  await soft('kiểm tra', async () => {
    const mk = async (template: string, count: number) => {
      const ids: string[] = [];
      for (let i = 1; i <= count; i++) ids.push((await must(call, 'POST', '/api/v1/academics/units', { template, name: `Unit ${i}`, topic: `Chủ đề mẫu ${i}`, words: ['hello', 'friend', 'school', 'family'], patterns: ['This is my …', 'I like …'] })).unit.id);
      return ids;
    };
    const cam = await mk('cambridge', 3);
    await mk('foundation', 2);
    await mk('baby', 2);
    const starters = enrollments.filter((e) => e.program === 'starters-nen-tang');
    const done = (await must(call, 'POST', '/api/v1/exams/plans', { enrollmentId: starters[0].id, plannedDate: '2026-10-20', unitIds: cam.slice(0, 2) })).plan;
    await must(call, 'PUT', `/api/v1/exams/plans/${done.id}/result`, {
      units: cam.slice(0, 2).map((unitId) => ({ unitId, values: { pattern: 82, freestyle: 76, pron1: 'clear', pron2: 'clear', gram1: 'ok', gram2: 'ok' } })),
      comment: 'Tiến bộ tốt (dữ liệu demo)', support: 'Luyện thêm phát âm cuối từ',
    });
    await must(call, 'POST', '/api/v1/exams/plans', { enrollmentId: starters[1].id, plannedDate: '2026-10-28', unitIds: cam.slice(0, 2) });
  });

  // Lịch CAP: xếp các lớp vào ô
  await soft('lịch CAP', async () => {
    const groupOf = (w: number[]) => (w[0] === 1 ? '2-4-6' : '3-5');
    const classes = (await must(call, 'GET', '/api/v1/classes')).classes as { id: string; name: string }[];
    for (const d of defs) {
      const c = classes.find((x) => x.name === d.name)!;
      await must(call, 'POST', '/api/v1/cap', { classId: c.id, group: groupOf(d.weekdays), slotId: d.slotId, room: d.room });
    }
  });
}
