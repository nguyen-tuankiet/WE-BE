import { DEFAULT_SETTINGS, PROGRAMS, ROOMS, SLOTS } from '../domain/catalog.js';
import type { Db } from '../db/types.js';

/** Nạp dữ liệu danh mục (46 gói, ca, phòng, cài đặt mặc định). Chạy lặp được: không ghi đè giá trị đã chỉnh sửa. */
export async function seedReference(db: Db): Promise<void> {
  await db.tx(async (q) => {
    for (const [i, s] of SLOTS.entries()) {
      await q.query('INSERT INTO slots (id, label, time_range, sort_order) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING', [s.id, s.label, s.timeRange, i]);
    }
    for (const [i, r] of ROOMS.entries()) {
      await q.query('INSERT INTO rooms (id, floor, sort_order) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [r.id, r.floor, i]);
    }
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await q.query('INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value)]);
    }
    for (const [i, p] of PROGRAMS.entries()) {
      await q.query(
        `INSERT INTO programs (id, grp, name, tuition, sessions_count, max_size, unit_template, note, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING`,
        [p.id, p.group, p.name, p.tuition, p.sessions, p.maxSize, p.unitTemplate, p.note ?? null, i],
      );
    }
  });
}
