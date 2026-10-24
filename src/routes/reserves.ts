import { Hono } from 'hono';
import { z } from 'zod';
import { dateSchema, idParam, idSchema } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createReserve, listReserves, returnFromReserve, parseNotice } from '../services/reserves.js';
import type { AppEnv, Deps } from '../types.js';

const newReserve = z.object({
  enrollmentId: idSchema,
  noticeAt: z.string().refine((v) => parseNotice(v) !== null, 'Thời điểm thông báo không hợp lệ (YYYY-MM-DDTHH:mm).'),
  completedOn: dateSchema,
  absentStreak: z.number().int().min(0).max(1000),
  amount: z.number().int().min(0),
  note: z.string().trim().max(500).default(''),
});

const returnBody = z.object({ classId: idSchema, returnedOn: dateSchema });

/** Bảo lưu & nhập học lại: chỉ Admin/Manager (docs/01 — "Xếp bù và bảo lưu"). */
export function reserveRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps), requireRole('admin', 'manager'));

  app.get('/', async (c) => c.json({ reserves: await listReserves(deps.db, deps.today()) }));

  app.post('/', async (c) => {
    const body = await parseBody(c, newReserve);
    return c.json(await createReserve(deps.db, c.get('user'), body, deps.today()), 201);
  });

  app.post('/:id/return', async (c) => {
    const body = await parseBody(c, returnBody);
    return c.json(await returnFromReserve(deps.db, c.get('user'), idParam(c.req.param('id'), 'Hồ sơ bảo lưu'), body, deps.today()));
  });

  return app;
}
