import type { Db, Queryable } from './types.js';

export interface CompatResult {
  name: string;
  ok: boolean;
  error?: string;
}

class Rollback extends Error {}

const sqlState = (err: unknown) => (err as { code?: string })?.code;

/** Các tính năng PostgreSQL mà thiết kế (docs/10) đang dựa vào. Mỗi mục chạy trong giao dịch rồi hoàn tác, không để lại dữ liệu. */
const CHECKS: { name: string; run: (q: Queryable) => Promise<void> }[] = [
  {
    name: 'Cột identity + INSERT … RETURNING',
    async run(q) {
      await q.exec('CREATE TEMP TABLE c1 (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, v text)');
      const r = await q.query<{ id: string }>('INSERT INTO c1 (v) VALUES ($1) RETURNING id::text AS id', ['a']);
      if (!r.rows[0]?.id) throw new Error('RETURNING không trả id');
    },
  },
  {
    name: 'UNIQUE nhiều cột (một khóa + một ngày chỉ một điểm danh)',
    async run(q) {
      await q.exec('CREATE TEMP TABLE c2 (e bigint NOT NULL, d date NOT NULL, UNIQUE (e, d))');
      await q.query("INSERT INTO c2 VALUES (1, '2026-10-22')");
      try {
        await q.query("INSERT INTO c2 VALUES (1, '2026-10-22')");
      } catch (err) {
        if (sqlState(err) === '23505') return;
        throw err;
      }
      throw new Error('Không chặn được bản ghi trùng');
    },
  },
  {
    name: 'Chỉ mục duy nhất MỘT PHẦN (một buổi vắng ≤ 1 lượt bù hiệu lực)',
    async run(q) {
      await q.exec(
        "CREATE TEMP TABLE c3 (e bigint NOT NULL, absence date NOT NULL, status text NOT NULL); CREATE UNIQUE INDEX c3_active ON c3 (e, absence) WHERE status <> 'cancelled'",
      );
      await q.query("INSERT INTO c3 VALUES (1, '2026-10-01', 'cancelled')");
      await q.query("INSERT INTO c3 VALUES (1, '2026-10-01', 'cancelled')");
      await q.query("INSERT INTO c3 VALUES (1, '2026-10-01', 'scheduled')");
      try {
        await q.query("INSERT INTO c3 VALUES (1, '2026-10-01', 'done')");
      } catch (err) {
        if (sqlState(err) === '23505') return;
        throw err;
      }
      throw new Error('Cho phép hai lượt bù hiệu lực cho cùng một buổi vắng');
    },
  },
  {
    name: 'Khóa ngoại + ON DELETE CASCADE',
    async run(q) {
      await q.exec('CREATE TEMP TABLE p4 (id bigint PRIMARY KEY); CREATE TEMP TABLE c4 (p bigint REFERENCES p4 (id) ON DELETE CASCADE)');
      await q.query('INSERT INTO p4 VALUES (1)');
      await q.query('INSERT INTO c4 VALUES (1)');
      await q.query('DELETE FROM p4 WHERE id = 1');
      const n = await q.query<{ n: number }>('SELECT count(*)::int AS n FROM c4');
      if (n.rows[0].n !== 0) throw new Error('CASCADE không xóa bản ghi con');
    },
  },
  {
    name: 'Ràng buộc CHECK',
    async run(q) {
      await q.exec("CREATE TEMP TABLE c5 (role text CHECK (role IN ('admin','teacher')))");
      try {
        await q.query("INSERT INTO c5 VALUES ('hacker')");
      } catch (err) {
        if (sqlState(err) === '23514') return;
        throw err;
      }
      throw new Error('CHECK không chặn giá trị sai');
    },
  },
  {
    name: 'jsonb (chụp nội dung Unit đã dùng)',
    async run(q) {
      await q.exec('CREATE TEMP TABLE c6 (snap jsonb)');
      await q.query('INSERT INTO c6 VALUES ($1)', [JSON.stringify({ unit: 'U1', words: ['a', 'b'] })]);
      const r = await q.query<{ unit: string }>("SELECT snap->>'unit' AS unit FROM c6");
      if (r.rows[0]?.unit !== 'U1') throw new Error('Không đọc được trường jsonb');
    },
  },
  {
    name: 'timestamptz + now() + khoảng thời gian (make_interval)',
    async run(q) {
      const r = await q.query<{ ok: boolean }>("SELECT (now() + make_interval(hours => 48)) > (now() + interval '47 hours') AS ok");
      if (!r.rows[0]?.ok) throw new Error('Tính khoảng thời gian sai');
    },
  },
  {
    name: 'Phép tính ngày + generate_series',
    async run(q) {
      const r = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM generate_series(date '2026-10-01', date '2026-10-31', interval '1 day')");
      if (r.rows[0]?.n !== 31) throw new Error('generate_series trả sai số ngày');
      const d = await q.query<{ d: string }>("SELECT (date '2026-10-22' + 7)::text AS d");
      if (d.rows[0]?.d !== '2026-10-29') throw new Error('date + số nguyên sai');
    },
  },
  {
    name: 'INSERT … ON CONFLICT DO UPDATE (lưu lặp không nhân đôi)',
    async run(q) {
      await q.exec('CREATE TEMP TABLE c9 (k text PRIMARY KEY, v int)');
      await q.query('INSERT INTO c9 VALUES ($1, 1) ON CONFLICT (k) DO UPDATE SET v = c9.v + 1', ['a']);
      await q.query('INSERT INTO c9 VALUES ($1, 1) ON CONFLICT (k) DO UPDATE SET v = c9.v + 1', ['a']);
      const r = await q.query<{ v: number }>('SELECT v FROM c9');
      if (r.rowCount !== 1 || r.rows[0].v !== 2) throw new Error('ON CONFLICT hoạt động sai');
    },
  },
  {
    name: 'SELECT … FOR UPDATE (khóa hàng)',
    async run(q) {
      await q.exec('CREATE TEMP TABLE c10 (id int PRIMARY KEY)');
      await q.query('INSERT INTO c10 VALUES (1)');
      const r = await q.query('SELECT id FROM c10 WHERE id = 1 FOR UPDATE');
      if (r.rowCount !== 1) throw new Error('FOR UPDATE không trả hàng');
    },
  },
  {
    name: 'Mảng smallint[] + unnest nhiều mảng (sinh hàng loạt buổi học)',
    async run(q) {
      await q.exec('CREATE TEMP TABLE c11 (e bigint, seq int, d date, w smallint[])');
      await q.query(
        'INSERT INTO c11 (e, seq, d, w) SELECT $1::bigint, s.seq, s.d::date, $4::smallint[] FROM unnest($2::int[], $3::text[]) AS s(seq, d)',
        ['7', [1, 2, 3], ['2026-10-05', '2026-10-07', '2026-10-09'], [1, 3, 5]],
      );
      const r = await q.query<{ n: number; last: string; card: number }>(
        'SELECT count(*)::int AS n, max(d)::text AS last, max(cardinality(w))::int AS card FROM c11',
      );
      if (r.rows[0].n !== 3 || r.rows[0].last !== '2026-10-09' || r.rows[0].card !== 3) throw new Error('unnest/mảng cho kết quả sai');
    },
  },
  {
    name: 'Sequence + nextval + lpad (mã học viên HV0001)',
    async run(q) {
      await q.exec('CREATE TEMP SEQUENCE c12_seq START 1');
      const r = await q.query<{ code: string }>("SELECT 'HV' || lpad(nextval('c12_seq')::text, 4, '0') AS code");
      if (r.rows[0].code !== 'HV0001') throw new Error(`Mã sinh ra là ${r.rows[0].code}`);
    },
  },
  {
    name: 'Khóa ngoại tổng hợp (khóa, ngày) tới UNIQUE — chỉ điểm danh được ngày có trong lịch',
    async run(q) {
      await q.exec(
        'CREATE TEMP TABLE c13s (e bigint, d date, UNIQUE (e, d)); CREATE TEMP TABLE c13a (e bigint, d date, FOREIGN KEY (e, d) REFERENCES c13s (e, d))',
      );
      await q.query("INSERT INTO c13s VALUES (1, '2026-10-05')");
      await q.query("INSERT INTO c13a VALUES (1, '2026-10-05')");
      try {
        await q.query("INSERT INTO c13a VALUES (1, '2026-10-06')");
      } catch (err) {
        if (sqlState(err) === '23503') return;
        throw err;
      }
      throw new Error('Khóa ngoại tổng hợp không chặn ngày ngoài lịch');
    },
  },
  {
    name: 'Đánh lại số thứ tự bằng UPDATE … FROM (row_number) qua bước số âm',
    async run(q) {
      await q.exec('CREATE TEMP TABLE c14 (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, e bigint, seq int, d date, UNIQUE (e, seq))');
      await q.query("INSERT INTO c14 (e, seq, d) VALUES (1, 1, '2026-10-05'), (1, 2, '2026-10-09'), (1, 1000000, '2026-10-07')");
      await q.query('UPDATE c14 SET seq = -id WHERE e = $1', [1]);
      await q.query('UPDATE c14 SET seq = r.rn FROM (SELECT id, row_number() OVER (ORDER BY d)::int AS rn FROM c14 WHERE e = $1) r WHERE c14.id = r.id AND c14.e = $1', [1]);
      const r = await q.query<{ ds: string }>("SELECT string_agg(d::text, ',' ORDER BY seq) AS ds FROM c14");
      if (r.rows[0].ds !== '2026-10-05,2026-10-07,2026-10-09') throw new Error(`Thứ tự sau đánh lại: ${r.rows[0].ds}`);
    },
  },
  {
    name: 'Cộng tháng cho ngày (hạn bảo lưu 2 tháng, cuối tháng được ghim)',
    async run(q) {
      const r = await q.query<{ a: string; b: string }>(
        "SELECT (date '2026-10-26' + interval '2 months')::date::text AS a, (date '2026-12-31' + interval '2 months')::date::text AS b",
      );
      if (r.rows[0].a !== '2026-12-26' || r.rows[0].b !== '2027-02-28') throw new Error(`Kết quả: ${r.rows[0].a}, ${r.rows[0].b}`);
    },
  },
  {
    name: 'UPDATE … RETURNING kèm truy vấn con (đánh dấu bảo lưu hết hạn)',
    async run(q) {
      await q.exec("CREATE TEMP TABLE c15p (id int PRIMARY KEY, student int); CREATE TEMP TABLE c15 (id int PRIMARY KEY, pid int, status text, exp date); INSERT INTO c15p VALUES (1, 77); INSERT INTO c15 VALUES (1, 1, 'active', '2026-09-10')");
      const r = await q.query<{ id: string; student: string }>(
        "UPDATE c15 r SET status = 'expired' WHERE r.status = 'active' AND r.exp < $1::date RETURNING r.id::text AS id, (SELECT p.student::text FROM c15p p WHERE p.id = r.pid) AS student",
        ['2026-10-22'],
      );
      if (r.rowCount !== 1 || r.rows[0].student !== '77') throw new Error('RETURNING với truy vấn con cho kết quả sai');
    },
  },
  {
    name: 'Hàm cửa sổ row_number() + count(*) FILTER',
    async run(q) {
      const r = await q.query<{ rn: number; f: number }>(
        "SELECT row_number() OVER (ORDER BY x)::int AS rn, count(*) FILTER (WHERE x > 1)  OVER ()::int AS f FROM (VALUES (1),(2),(3)) AS t(x) ORDER BY 1 DESC LIMIT 1",
      );
      if (r.rows[0]?.rn !== 3 || r.rows[0]?.f !== 2) throw new Error('Hàm cửa sổ cho kết quả sai');
    },
  },
];

export async function runCompatChecks(db: Db): Promise<CompatResult[]> {
  const results: CompatResult[] = [];
  for (const check of CHECKS) {
    try {
      await db.tx(async (q) => {
        await check.run(q);
        throw new Rollback();
      });
    } catch (err) {
      if (err instanceof Rollback) {
        results.push({ name: check.name, ok: true });
        continue;
      }
      results.push({ name: check.name, ok: false, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    results.push({ name: check.name, ok: true });
  }

  // Giao dịch phải thật sự hoàn tác khi gặp lỗi (dữ liệu nhiều bước không bị lưu dở).
  try {
    await db.exec('CREATE TABLE IF NOT EXISTS _compat_tx (v int)');
    await db.tx(async (q) => {
      await q.query('INSERT INTO _compat_tx VALUES (1)');
      throw new Error('hoàn tác');
    }).catch(() => undefined);
    const n = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM _compat_tx');
    await db.exec('DROP TABLE _compat_tx');
    results.push(n.rows[0].n === 0 ? { name: 'Hoàn tác giao dịch khi có lỗi', ok: true } : { name: 'Hoàn tác giao dịch khi có lỗi', ok: false, error: 'Dữ liệu vẫn còn sau ROLLBACK' });
  } catch (err) {
    results.push({ name: 'Hoàn tác giao dịch khi có lỗi', ok: false, error: err instanceof Error ? err.message : String(err) });
  }
  return results;
}
