import { describe, expect, it } from 'vitest';
import { runCompatChecks } from '../src/db/compat.js';
import { createPgliteDb } from '../src/db/pglite.js';

describe('tương thích PostgreSQL', () => {
  it('mọi tính năng thiết kế đang dựa vào đều đạt trên PostgreSQL nhúng', async () => {
    const db = await createPgliteDb();
    const results = await runCompatChecks(db);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(18);
  });
});
