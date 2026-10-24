/**
 * Chạy API trên PostgreSQL nhúng (PGlite, trong bộ nhớ) kèm DỮ LIỆU DEMO để thử giao diện khi chưa có Neon.
 * Mỗi lần chạy là một cơ sở dữ liệu mới (tắt là mất). KHÔNG dùng cho dữ liệu thật.
 *   npm run dev:demo            # cổng 8787, "hôm nay" = 2026-10-22 (khớp bản xem trước giao diện)
 *   DEMO_TODAY=real npm run dev:demo   # dùng ngày thật
 */
import { serve } from '@hono/node-server';
import { createApp } from '../src/app.js';
import { DEFAULT_APP_CONFIG } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPgliteDb } from '../src/db/pglite.js';
import { todayVN } from '../src/domain/dates.js';
import { DEMO_ACCOUNTS, DEMO_PIN, seedDemo, type Call } from '../src/seed/demo.js';
import { seedReference } from '../src/seed/reference.js';

const port = Number(process.env.PORT ?? 8787);
const fixed = process.env.DEMO_TODAY === 'real' ? null : (process.env.DEMO_TODAY ?? '2026-10-22');
const today = () => fixed ?? todayVN();
const secret = 'demo-bootstrap-secret-0000';

const db = await createPgliteDb();
await runMigrations(db);
await seedReference(db);
const app = createApp({
  db,
  config: { ...DEFAULT_APP_CONFIG, bootstrapSecret: secret, corsOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174', 'http://localhost:4173'] },
  today,
});

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

const admin = DEMO_ACCOUNTS[0];
await call('POST', '/api/v1/auth/bootstrap', { secret, email: admin.email, name: admin.name, pin: DEMO_PIN });
await call('POST', '/api/v1/auth/login', { email: admin.email, pin: DEMO_PIN });
await seedDemo(db, call, today());
await call('POST', '/api/v1/auth/logout');

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\nWE backend DEMO (PGlite, dữ liệu giả) tại http://localhost:${info.port} — hôm nay = ${today()}`);
  console.log(`Tài khoản (PIN ${DEMO_PIN}): ${DEMO_ACCOUNTS.map((a) => a.email).join(', ')}\n`);
});
