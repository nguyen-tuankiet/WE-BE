import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './types.js';

export const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations');

/** Chạy các file `migrations/NNNN_*.sql` chưa áp dụng, mỗi file một giao dịch. Trả về danh sách vừa chạy. */
export async function runMigrations(db: Db, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    await db.tx(async (q) => {
      await q.exec(sql);
      await q.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    applied.push(file);
  }
  return applied;
}
