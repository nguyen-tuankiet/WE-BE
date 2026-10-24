import pg from 'pg';
import type { Db, Queryable, Row } from './types.js';

function wrap(client: pg.Pool | pg.PoolClient): Queryable {
  return {
    async query<T extends Row = Row>(text: string, params?: unknown[]) {
      const res = await client.query(text, params as unknown[] | undefined);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    },
    async exec(sql: string) {
      await client.query(sql);
    },
  };
}

/** Kết nối PostgreSQL thật (Neon hoặc nơi khác) qua `DATABASE_URL`. */
export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000 });
  const base = wrap(pool);
  return {
    ...base,
    async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
