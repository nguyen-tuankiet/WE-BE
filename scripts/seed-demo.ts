/**
 * Nạp dữ liệu MẪU (tên giả) vào cơ sở dữ liệu đang cấu hình ở .env, để xem thử giao diện.
 *   DEMO_ADMIN_PIN=<PIN của admin@we.vn> npm run seed:demo
 * Chỉ chạy khi DB chưa có học viên/lớp nào (tránh làm bẩn dữ liệu thật). Thêm --force để bỏ qua kiểm tra này.
 */
import { existsSync } from 'node:fs';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createPgDb } from '../src/db/pg.js';
import { todayVN } from '../src/domain/dates.js';
import { DEMO_ACCOUNTS, seedDemo, type Call } from '../src/seed/demo.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const pin = process.env.DEMO_ADMIN_PIN;
if (!pin) {
  console.error('Thiếu DEMO_ADMIN_PIN (PIN của admin@we.vn) trong biến môi trường.');
  process.exit(1);
}

const config = loadConfig();
const db = createPgDb(config.databaseUrl);
const today = todayVN();

try {
  const used = await db.query<{ students: number; classes: number }>('SELECT (SELECT count(*) FROM students)::int AS students, (SELECT count(*) FROM classes)::int AS classes');
  if ((used.rows[0].students > 0 || used.rows[0].classes > 0) && !process.argv.includes('--force')) {
    console.error(`DB đã có dữ liệu (${used.rows[0].students} học viên, ${used.rows[0].classes} lớp). Dừng để không trộn dữ liệu mẫu với dữ liệu thật. Dùng --force nếu chắc chắn.`);
    process.exit(1);
  }

  const app = createApp({ db, config: config.app, today: () => today });
  let cookie = '';
  const call: Call = async (method, path, body) => {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (cookie) headers.cookie = cookie;
    const res = await app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const m = /we_session=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
    if (m) cookie = m[1] ? `we_session=${m[1]}` : '';
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const login = await call('POST', '/api/v1/auth/login', { email: DEMO_ACCOUNTS[0].email, pin });
  if (login.status !== 200) throw new Error(`Đăng nhập admin thất bại (${login.status}). Kiểm tra DEMO_ADMIN_PIN.`);
  await seedDemo(db, call, today);
  await call('POST', '/api/v1/auth/logout');
  console.log(`Đã nạp dữ liệu mẫu (hôm nay = ${today}). Tài khoản mẫu (PIN 123456): ${DEMO_ACCOUNTS.slice(1).map((a) => a.email).join(', ')}`);
} finally {
  await db.close();
}
