import { Hono } from 'hono';
import { z } from 'zod';
import { dateSchema, idParam, idSchema } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createMakeup, listMakeups, setMakeupStatus } from '../services/makeups.js';
import type { AppEnv, Deps } from '../types.js';

const newMakeup = z.object({
  enrollmentId: idSchema,
  absenceDate: dateSchema,
  date: dateSchema,
  room: z.string().trim().min(1, 'Chọn phòng.').max(30),
  notifiedParent: z.boolean().default(false),
  note: z.string().trim().max(500).default(''),
});

const statusBody = z.object({
  status: z.enum(['done', 'missed', 'cancelled']),
  note: z.string().trim().max(500).default(''),
});

/** Học bù: Admin/Manager xếp và xử lý; giáo viên chỉ xem lượt bù của lớp mình (docs/01). */
export function makeupRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps));
  const manage = requireRole('admin', 'manager');

  app.get('/', requireRole('admin', 'manager', 'teacher'), async (c) => c.json(await listMakeups(deps.db, c.get('user'))));

  app.post('/', manage, async (c) => {
    const body = await parseBody(c, newMakeup);
    return c.json({ makeup: await createMakeup(deps.db, c.get('user'), body) }, 201);
  });

  app.patch('/:id', manage, async (c) => {
    const body = await parseBody(c, statusBody);
    const makeup = await setMakeupStatus(deps.db, c.get('user'), idParam(c.req.param('id'), 'Lượt bù'), body.status, body.note, deps.today());
    return c.json({ makeup });
  });

  return app;
}
