import { Hono } from 'hono';
import { z } from 'zod';
import { dateSchema, idParam, idSchema, weekdaysSchema } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createEnrollment, listEnrollments, transferEnrollment, updateEnrollment } from '../services/enrollments.js';
import type { AppEnv, Deps } from '../types.js';

const newEnrollment = z.object({
  studentId: idSchema,
  programId: z.string().min(1, 'Chọn chương trình.'),
  classId: idSchema,
  startDate: dateSchema,
  weekdays: weekdaysSchema.optional(),
  totalSessions: z.number().int().min(1).max(200).optional(),
  tuition: z.number().int().min(0).optional(),
  tuitionReceived: z.boolean().optional(),
  note: z.string().trim().max(500).optional(),
});

const enrollmentPatch = z
  .object({
    tuitionReceived: z.boolean().optional(),
    tuition: z.number().int().min(0).optional(),
    note: z.string().trim().max(500).optional(),
    totalSessions: z.number().int().min(1).max(200).optional(),
    startDate: dateSchema.optional(),
    status: z.literal('completed').optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Không có thay đổi nào.' });

const transferBody = z.object({
  toClassId: idSchema,
  effectiveDate: dateSchema,
  weekdays: weekdaysSchema.optional(),
  note: z.string().trim().max(500).optional(),
});

/** Khóa đăng ký: chỉ Admin/Manager (docs/01 — "Hồ sơ học viên và khóa"). */
export function enrollmentRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps), requireRole('admin', 'manager'));

  app.get('/', async (c) => c.json({ enrollments: await listEnrollments(deps.db, deps.today()) }));

  app.post('/', async (c) => {
    const body = await parseBody(c, newEnrollment);
    return c.json({ enrollment: await createEnrollment(deps.db, deps.today(), body, c.get('user').id) }, 201);
  });

  app.patch('/:id', async (c) => {
    const body = await parseBody(c, enrollmentPatch);
    return c.json({ enrollment: await updateEnrollment(deps.db, deps.today(), idParam(c.req.param('id'), 'Khóa đăng ký'), body, c.get('user').id) });
  });

  app.post('/:id/transfer', async (c) => {
    const body = await parseBody(c, transferBody);
    const result = await transferEnrollment(deps.db, deps.today(), idParam(c.req.param('id'), 'Khóa đăng ký'), body, c.get('user').id);
    return c.json(result);
  });

  return app;
}
