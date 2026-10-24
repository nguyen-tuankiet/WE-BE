import { existsSync } from 'node:fs';
import { runCompatChecks } from '../src/db/compat.js';
import { createPgDb } from '../src/db/pg.js';
import { createPgliteDb } from '../src/db/pglite.js';

if (existsSync('.env')) process.loadEnvFile('.env');

// `npm run check-compat` kiểm tra DB thật trong DATABASE_URL; thêm `-- --pglite` để chạy thử trên PostgreSQL nhúng.
const usePglite = process.argv.includes('--pglite');
const url = process.env.DATABASE_URL;
if (!usePglite && !url) {
  console.error('Thiếu DATABASE_URL (đặt trong backend/.env), hoặc chạy với --pglite.');
  process.exit(1);
}

const db = usePglite ? await createPgliteDb() : createPgDb(url!);
try {
  const results = await runCompatChecks(db);
  for (const r of results) console.log(`${r.ok ? 'ĐẠT   ' : 'KHÔNG  '} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed}/${results.length} mục không đạt.` : `\nTất cả ${results.length} mục đạt.`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await db.close();
}
