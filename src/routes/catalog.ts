import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors.js';
import { isIsoDate } from '../domain/dates.js';
import { dateSchema, nonEmpty } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { addHoliday, listHolidays, removeHoliday } from '../services/holidays.js';
import { getSettings, listPrograms, listReference, updateProgram, updateSettings } from '../services/reference.js';
import type { AppEnv, Deps } from '../types.js';

const programPatch = z
  .object({
    name: nonEmpty('tên chương trình').optional(),
    tuition: z.number().int().min(0).optional(),
    sessionsCount: z.number().int().min(1).nullable().optional(),
    maxSize: z.number().int().min(1).optional(),
    note: z.string().max(500).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Không có thay đổi nào.' });

const settingsPatch = z
  .object({
    reminderDays: z.number().int().min(7).max(90).optional(),
    teacherEditDays: z.number().int().min(0).max(30).optional(),
    redflagBelow: z.number().int().min(0).max(100).optional(),
    goodAbove: z.number().int().min(0).max(100).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Không có thay đổi nào.' });

const holidayBody = z.object({ date: dateSchema, reason: nonEmpty('lý do', 200) });

/** Danh mục dùng chung: ca/phòng, gói chương trình, cài đặt, ngày nghỉ trung tâm. */
export function catalogRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;
  app.use('*', requireAuth(deps));
  const manage = requireRole('admin', 'manager');

  app.get('/reference', async (c) => c.json(await listReference(db)));

  /**
   * Giáo viên để xếp lớp (mặc định chỉ người đang hoạt động) hoặc để quản lý (`?all=1`: gồm cả người đã khóa, kèm email).
   * Manager không có quyền xem toàn bộ nhân sự nên cần endpoint riêng này.
   */
  app.get('/teachers', manage, async (c) => {
    const all = c.req.query('all') === '1';
    const res = await db.query<{ id: string; name: string; email: string; active: boolean; birthday: string | null }>(
      `SELECT u.id::text AS id, u.name, u.email, u.active, u.birthday::text AS birthday FROM users u JOIN user_roles r ON r.user_id = u.id AND r.role = 'teacher' ${all ? '' : 'WHERE u.active'} ORDER BY u.name`,
    );
    return c.json({ teachers: all ? res.rows : res.rows.map(({ id, name }) => ({ id, name })) });
  });

  app.get('/programs', async (c) => c.json({ programs: await listPrograms(db) }));
  app.patch('/programs/:id', manage, async (c) => {
    const body = await parseBody(c, programPatch);
    return c.json({ program: await updateProgram(db, c.req.param('id'), body, c.get('user').id) });
  });

  app.get('/settings', async (c) => c.json({ settings: await getSettings(db) }));
  app.put('/settings', manage, async (c) => {
    const body = await parseBody(c, settingsPatch);
    return c.json({ settings: await updateSettings(db, body, c.get('user').id) });
  });

  app.get('/holidays', async (c) => c.json({ holidays: await listHolidays(db) }));
  app.post('/holidays', manage, async (c) => {
    const body = await parseBody(c, holidayBody);
    return c.json({ holiday: await addHoliday(db, body, c.get('user').id) }, 201);
  });
  app.delete('/holidays/:date', manage, async (c) => {
    const date = c.req.param('date');
    if (!isIsoDate(date)) throw errors.notFound('Ngày nghỉ');
    return c.json(await removeHoliday(db, date, c.get('user').id));
  });

  return app;
}
