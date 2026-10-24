import { existsSync } from 'node:fs';
import { createPgDb } from '../src/db/pg.js';
import { seedReference } from '../src/seed/reference.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('Thiếu DATABASE_URL (đặt trong backend/.env).');
  process.exit(1);
}

const db = createPgDb(url);
try {
  await seedReference(db);
  console.log('Đã nạp danh mục: 46 gói, ca học, phòng, cài đặt mặc định (không ghi đè dữ liệu đã có).');
} finally {
  await db.close();
}
