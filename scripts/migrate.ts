import { existsSync } from 'node:fs';
import { createPgDb } from '../src/db/pg.js';
import { runMigrations } from '../src/db/migrate.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Thiếu DATABASE_URL (đặt trong backend/.env).');
  process.exit(1);
}

const db = createPgDb(url);
try {
  const applied = await runMigrations(db);
  console.log(applied.length ? `Đã chạy ${applied.length} migration:\n- ${applied.join('\n- ')}` : 'Không có migration mới.');
} finally {
  await db.close();
}
