import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors.js';
import { dateSchema, idParam, idSchema } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { getLedger, getSheet, saveAttendance } from '../services/attendance.js';
import type { AppEnv, Deps } from '../types.js';
import { isIsoDate } from '../domain/dates.js';

const item = z
  .object({
    enrollmentId: idSchema,
    status: z.enum(['present', 'late', 'absent']),
    notified: z.boolean().default(false),
    note: z.string().trim().max(300).default(''),
  })
  .refine((v) => !v.notified || v.status === 'absent', { message: '"Đã báo nghỉ" chỉ áp dụng cho buổi Vắng.', path: ['notified'] });

const saveBody = z.object({
  classId: idSchema,
  date: dateSchema,
  items: z.array(item).min(1, 'Chưa có học viên nào để lưu.').max(200),
});

/** Điểm danh: Admin, Manager, Giáo viên (docs/01). Thanh tra không điểm danh. */
export function attendanceRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps), requireRole('admin', 'manager', 'teacher'));

  app.get('/sheet', async (c) => {
    const classId = idParam(c.req.query('classId') ?? '', 'Lớp');
    const date = c.req.query('date') ?? '';
    if (!isIsoDate(date)) throw errors.validation({ date: 'Ngày không hợp lệ (YYYY-MM-DD).' });
    return c.json(await getSheet(deps.db, c.get('user'), classId, date, deps.today()));
  });

  app.put('/', async (c) => {
    const body = await parseBody(c, saveBody);
    return c.json(await saveAttendance(deps.db, c.get('user'), body, deps.today()));
  });

  app.get('/ledger', async (c) => {
    const classId = idParam(c.req.query('classId') ?? '', 'Lớp');
    const month = c.req.query('month') ?? '';
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw errors.validation({ month: 'Tháng không hợp lệ (YYYY-MM).' });
    return c.json(await getLedger(deps.db, c.get('user'), classId, month, deps.today()));
  });

  return app;
}
