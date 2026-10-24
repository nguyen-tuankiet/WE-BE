import { Hono } from 'hono';
import { z } from 'zod';
import { idParam, idSchema, nonEmpty, weekdaysSchema } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createClass, getClassDetail, listClasses, updateClass } from '../services/classes.js';
import type { AppEnv, Deps } from '../types.js';

const newClass = z.object({
  name: nonEmpty('tên lớp', 120),
  subject: z.string().trim().max(60).default(''),
  slotId: nonEmpty('ca học', 30),
  room: nonEmpty('phòng', 30),
  teacherId: idSchema.nullable().default(null),
  assistant: z.string().trim().max(120).default(''),
  maxSize: z.number().int().min(1).max(100).default(10),
  weekdays: weekdaysSchema,
});

const classPatch = z
  .object({
    name: nonEmpty('tên lớp', 120).optional(),
    subject: z.string().trim().max(60).optional(),
    slotId: nonEmpty('ca học', 30).optional(),
    room: nonEmpty('phòng', 30).optional(),
    teacherId: idSchema.nullable().optional(),
    assistant: z.string().trim().max(120).optional(),
    maxSize: z.number().int().min(1).max(100).optional(),
    weekdays: weekdaysSchema.optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Không có thay đổi nào.' });

export function classRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;
  app.use('*', requireAuth(deps));
  const manage = requireRole('admin', 'manager');

  app.get('/', async (c) => c.json({ classes: await listClasses(db, c.get('user')) }));
  app.get('/:id', async (c) => c.json(await getClassDetail(db, c.get('user'), idParam(c.req.param('id'), 'Lớp'), deps.today())));

  app.post('/', manage, async (c) => {
    const body = await parseBody(c, newClass);
    return c.json({ class: await createClass(db, c.get('user'), body) }, 201);
  });
  app.patch('/:id', manage, async (c) => {
    const body = await parseBody(c, classPatch);
    return c.json({ class: await updateClass(db, c.get('user'), idParam(c.req.param('id'), 'Lớp'), body) });
  });

  return app;
}
