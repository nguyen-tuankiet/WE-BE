import { PGlite } from '@electric-sql/pglite';
import type { Db, Queryable, Row } from './types.js';

interface PgliteLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec(sql: string): Promise<unknown>;
}

function wrap(x: PgliteLike): Queryable {
  return {
    async query<T extends Row = Row>(text: string, params?: unknown[]) {
      const res = await x.query(text, params);
      // PGlite báo affectedRows = 0 cho SELECT; thống nhất với `pg`: có hàng trả về thì rowCount = số hàng.
      return { rows: res.rows as T[], rowCount: res.rows.length > 0 ? res.rows.length : (res.affectedRows ?? 0) };
    },
    async exec(sql: string) {
      await x.exec(sql);
    },
  };
}

/** PostgreSQL chạy ngay trong tiến trình (WASM) — dùng cho test, không cần cài DB. */
export async function createPgliteDb(): Promise<Db> {
  const db = new PGlite();
  await db.waitReady;
  return {
    ...wrap(db),
    tx: (fn) => db.transaction((tx) => fn(wrap(tx as unknown as PgliteLike))),
    close: () => db.close(),
  };
}
