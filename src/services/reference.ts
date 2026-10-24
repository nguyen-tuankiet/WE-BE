import type { Db, Queryable } from '../db/types.js';
import { AppError, errors } from '../errors.js';
import { audit } from './audit.js';

/* ---------- Gói chương trình ---------- */

export interface ProgramRow {
  id: string;
  group: string;
  name: string;
  tuition: number;
  sessionsCount: number | null;
  maxSize: number;
  unitTemplate: string | null;
  note: string | null;
  active: boolean;
}

const PROGRAM_SELECT = `SELECT id, grp AS "group", name, tuition::text AS tuition, sessions_count AS "sessionsCount",
  max_size AS "maxSize", unit_template AS "unitTemplate", note, active FROM programs`;

type ProgramDb = Omit<ProgramRow, 'tuition'> & { tuition: string };
const toProgram = (r: ProgramDb): ProgramRow => ({ ...r, tuition: Number(r.tuition) });

export async function listPrograms(db: Db): Promise<ProgramRow[]> {
  const res = await db.query<ProgramDb>(`${PROGRAM_SELECT} ORDER BY sort_order, id`);
  return res.rows.map(toProgram);
}

export interface ProgramPatch {
  name?: string;
  tuition?: number;
  sessionsCount?: number | null;
  maxSize?: number;
  note?: string | null;
  active?: boolean;
}

/** Sửa danh mục dùng chung. KHÔNG ghi đè các khóa đã đăng ký (khóa đã chụp học phí/định mức lúc đăng ký). */
export async function updateProgram(db: Db, id: string, patch: ProgramPatch, actorId: string): Promise<ProgramRow> {
  const columns: Record<keyof ProgramPatch, string> = {
    name: 'name',
    tuition: 'tuition',
    sessionsCount: 'sessions_count',
    maxSize: 'max_size',
    note: 'note',
    active: 'active',
  };
  return db.tx(async (q) => {
    const cur = await q.query('SELECT 1 FROM programs WHERE id = $1 FOR UPDATE', [id]);
    if (cur.rowCount === 0) throw errors.notFound('Chương trình');
    const sets: string[] = [];
    const params: unknown[] = [id];
    for (const key of Object.keys(columns) as (keyof ProgramPatch)[]) {
      if (patch[key] === undefined) continue;
      params.push(patch[key]);
      sets.push(`${columns[key]} = $${params.length}`);
    }
    if (sets.length > 0) await q.query(`UPDATE programs SET ${sets.join(', ')} WHERE id = $1`, params);
    await audit(q, { userId: actorId, entity: 'program', entityId: id, action: 'update', detail: { ...patch } });
    const res = await q.query<ProgramDb>(`${PROGRAM_SELECT} WHERE id = $1`, [id]);
    return toProgram(res.rows[0]);
  });
}

/* ---------- Ca học & phòng ---------- */

export async function listReference(db: Db) {
  const slots = await db.query<{ id: string; label: string; timeRange: string }>(
    'SELECT id, label, time_range AS "timeRange" FROM slots ORDER BY sort_order',
  );
  const rooms = await db.query<{ id: string; floor: string }>('SELECT id, floor FROM rooms ORDER BY sort_order');
  return { slots: slots.rows, rooms: rooms.rows };
}

/* ---------- Cài đặt ---------- */

export interface Settings {
  reminderDays: number;
  teacherEditDays: number;
  redflagBelow: number;
  goodAbove: number;
}

const SETTING_KEYS: Record<keyof Settings, string> = {
  reminderDays: 'reminder_days',
  teacherEditDays: 'teacher_edit_days',
  redflagBelow: 'redflag_below',
  goodAbove: 'good_above',
};

export async function getSettings(db: Queryable): Promise<Settings> {
  const res = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  const byKey = new Map(res.rows.map((r) => [r.key, Number(r.value)]));
  const out = {} as Settings;
  for (const [field, key] of Object.entries(SETTING_KEYS) as [keyof Settings, string][]) {
    const v = byKey.get(key);
    if (v === undefined) throw new AppError(503, 'SETTINGS_MISSING', 'Chưa nạp cài đặt mặc định. Chạy `npm run seed`.');
    out[field] = v;
  }
  return out;
}

export async function updateSettings(db: Db, patch: Partial<Settings>, actorId: string): Promise<Settings> {
  const next = { ...(await getSettings(db)), ...patch };
  if (next.redflagBelow >= next.goodAbove) {
    throw errors.validation({ redflagBelow: 'Ngưỡng Redflag phải thấp hơn ngưỡng Good.' });
  }
  await db.tx(async (q) => {
    for (const [field, value] of Object.entries(patch) as [keyof Settings, number][]) {
      await q.query(
        `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [SETTING_KEYS[field], JSON.stringify(value)],
      );
    }
    await audit(q, { userId: actorId, entity: 'settings', entityId: 'global', action: 'update', detail: { ...patch } });
  });
  return next;
}
