import type { Db } from '../db/types.js';
import { isIsoDate } from '../domain/dates.js';
import type { AuthUser } from '../types.js';
import { audit } from './audit.js';

/* ---------- Xuất dữ liệu ---------- */

const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** CSV học viên (UTF-8 có BOM để Excel đọc đúng tiếng Việt). Chỉ Admin/Manager — có thông tin liên hệ. */
export async function exportStudentsCsv(db: Db): Promise<string> {
  const res = await db.query<{ code: string; name: string; birthday: string; status: string; class_name: string | null; guardian: string; phone: string; address: string; tuition_mode: string }>(
    `SELECT s.code, s.name, s.birthday::text AS birthday, s.status,
            (SELECT c.name FROM enrollments e JOIN classes c ON c.id = e.class_id WHERE e.student_id = s.id AND e.status = 'active' ORDER BY e.id LIMIT 1) AS class_name,
            s.guardian, s.phone, s.address, s.tuition_mode
       FROM students s ORDER BY s.code`,
  );
  const header = ['Mã', 'Họ tên', 'Ngày sinh', 'Trạng thái', 'Lớp', 'Phụ huynh', 'Điện thoại', 'Địa chỉ', 'Hình thức học phí'];
  const rows = res.rows.map((r) => [r.code, r.name, r.birthday, r.status, r.class_name, r.guardian, r.phone, r.address, r.tuition_mode].map(csvCell).join(','));
  return `﻿${[header.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`;
}

/* ---------- Nhập học viên ---------- */

export interface ImportRow {
  name?: string;
  birthday?: string;
  guardian?: string;
  phone?: string;
  address?: string;
  tuitionMode?: string;
  note?: string;
}

const HEADER_ALIASES: Record<string, keyof ImportRow> = {
  name: 'name',
  'họ tên': 'name',
  'họ và tên': 'name',
  'ho ten': 'name',
  'tên học viên': 'name',
  birthday: 'birthday',
  'ngày sinh': 'birthday',
  'ngay sinh': 'birthday',
  guardian: 'guardian',
  'phụ huynh': 'guardian',
  'phu huynh': 'guardian',
  phone: 'phone',
  'điện thoại': 'phone',
  'số điện thoại': 'phone',
  sđt: 'phone',
  sdt: 'phone',
  address: 'address',
  'địa chỉ': 'address',
  'dia chi': 'address',
  tuitionmode: 'tuitionMode',
  'hình thức học phí': 'tuitionMode',
  'hình thức đóng học phí': 'tuitionMode',
  note: 'note',
  'ghi chú': 'note',
};

/** Phân tích CSV đơn giản: dấu ngoặc kép, dấu phẩy/chấm phẩy/tab trong ô, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      cell = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

export function csvToRows(text: string): ImportRow[] {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  const cols = header.map((h) => HEADER_ALIASES[h.trim().toLowerCase()]);
  return body.map((cells) => {
    const row: ImportRow = {};
    cells.forEach((v, i) => {
      const key = cols[i];
      if (key) row[key] = v.trim();
    });
    return row;
  });
}

/** Nhận `DD/MM/YYYY` hoặc `YYYY-MM-DD`; không hợp lệ → null. */
function normalizeBirthday(value: string | undefined): string | null {
  const v = (value ?? '').trim();
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  const iso = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : v;
  return isIsoDate(iso) ? iso : null;
}

export interface ImportReport {
  dryRun: boolean;
  total: number;
  created: { row: number; id: string; code: string; name: string }[];
  /** Trùng (cùng họ tên + ngày sinh) với học viên đã có hoặc dòng trước đó: KHÔNG tự gộp, Admin đối chiếu */
  duplicates: { row: number; name: string; existingCode: string | null }[];
  errors: { row: number; message: string }[];
}

const key = (name: string, birthday: string) => `${name.trim().toLowerCase().replace(/\s+/g, ' ')}|${birthday}`;

/**
 * Nhập học viên qua bước đối chiếu. Chạy lặp không nhân đôi (trùng họ tên + ngày sinh bị bỏ qua và báo lại);
 * lô có dòng lỗi vẫn lưu các dòng hợp lệ trong MỘT giao dịch và báo rõ dòng lỗi. Cùng tên khác ngày sinh là học viên khác (mã riêng).
 * Số dòng tính từ 1 theo thứ tự dữ liệu (không tính dòng tiêu đề).
 */
export async function importStudents(db: Db, user: AuthUser, rows: ImportRow[], today: string, dryRun: boolean): Promise<ImportReport> {
  const report: ImportReport = { dryRun, total: rows.length, created: [], duplicates: [], errors: [] };
  const existing = await db.query<{ code: string; name: string; birthday: string }>('SELECT code, name, birthday::text AS birthday FROM students');
  const known = new Map(existing.rows.map((r) => [key(r.name, r.birthday), r.code]));
  const seen = new Set<string>();

  const valid: { row: number; data: Required<Pick<ImportRow, 'name'>> & { birthday: string; guardian: string; phone: string; address: string; tuitionMode: string; note: string } }[] = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    const name = (r.name ?? '').trim();
    if (!name) return void report.errors.push({ row: n, message: 'Thiếu họ tên.' });
    const birthday = normalizeBirthday(r.birthday);
    if (!birthday) return void report.errors.push({ row: n, message: 'Ngày sinh không hợp lệ (dùng DD/MM/YYYY hoặc YYYY-MM-DD).' });
    if (birthday > today) return void report.errors.push({ row: n, message: 'Ngày sinh không được ở tương lai.' });
    const phone = (r.phone ?? '').replace(/[\s.-]/g, '');
    if (phone && !/^0\d{9}$/.test(phone)) return void report.errors.push({ row: n, message: 'Số điện thoại gồm 10 chữ số, bắt đầu bằng 0.' });
    const k = key(name, birthday);
    if (known.has(k)) return void report.duplicates.push({ row: n, name, existingCode: known.get(k) ?? null });
    if (seen.has(k)) return void report.duplicates.push({ row: n, name, existingCode: null });
    seen.add(k);
    valid.push({ row: n, data: { name, birthday, guardian: (r.guardian ?? '').trim(), phone, address: (r.address ?? '').trim(), tuitionMode: (r.tuitionMode ?? '').trim(), note: (r.note ?? '').trim() } });
  });

  if (dryRun || valid.length === 0) return report;
  await db.tx(async (q) => {
    for (const v of valid) {
      const res = await q.query<{ id: string; code: string }>(
        `INSERT INTO students (code, name, birthday, guardian, phone, address, tuition_mode, note)
         VALUES ('HV' || lpad(nextval('student_code_seq')::text, 4, '0'), $1, $2::date, $3, $4, $5, $6, $7) RETURNING id::text AS id, code`,
        [v.data.name, v.data.birthday, v.data.guardian, v.data.phone, v.data.address, v.data.tuitionMode, v.data.note],
      );
      report.created.push({ row: v.row, id: res.rows[0].id, code: res.rows[0].code, name: v.data.name });
    }
    await audit(q, { userId: user.id, entity: 'import', entityId: 'students', action: 'import', detail: { total: rows.length, created: valid.length, duplicates: report.duplicates.length, errors: report.errors.length } });
  });
  return report;
}
