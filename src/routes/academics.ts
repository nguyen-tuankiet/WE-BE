import { Hono } from 'hono';
import { z } from 'zod';
import { CRITERIA } from '../domain/grading.js';
import { dateSchema, idParam, idSchema, nonEmpty } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createPlan, createUnit, getPlan, getStudentReport, listExams, listReportStudents, listUnits, saveResult, updateUnit } from '../services/academics.js';
import type { AppEnv, Deps } from '../types.js';

const template = z.enum(['baby', 'foundation', 'cambridge']);
const stringList = z.array(z.string().trim().min(1).max(120)).max(200);

const newUnit = z.object({
  template,
  name: nonEmpty('tên Unit', 80),
  topic: z.string().trim().max(200).default(''),
  words: stringList.default([]),
  patterns: stringList.default([]),
});
const unitPatch = z
  .object({ name: nonEmpty('tên Unit', 80).optional(), topic: z.string().trim().max(200).optional(), words: stringList.optional(), patterns: stringList.optional(), active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Không có thay đổi nào.' });

const newPlan = z.object({ enrollmentId: idSchema, plannedDate: dateSchema, unitIds: z.array(z.string().min(1)).min(1, 'Chọn ít nhất một Unit.').max(30) });

const resultBody = z.object({
  units: z
    .array(z.object({ unitId: z.string().min(1), values: z.record(z.string(), z.union([z.number(), z.string(), z.null()])) }))
    .min(1, 'Chưa chấm Unit nào.'),
  comment: z.string().trim().max(2000).default(''),
  support: z.string().trim().max(2000).default(''),
});

/**
 * Học vụ: Admin, Manager, Thanh tra nội bộ. Giáo viên chưa được cấp quyền chấm/xem kiểm tra ở bản đầu (docs/01).
 * Sửa khung nội dung: Admin, Manager, Thanh tra ("Sửa khung và ngưỡng riêng").
 */
export function academicsRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  // Mount ở /api/v1 cùng route khác nên chỉ áp quyền cho đúng tiền tố của mình
  for (const prefix of ['/academics/*', '/exams', '/exams/*', '/reports/*']) app.use(prefix, requireAuth(deps), requireRole('admin', 'manager', 'inspector'));
  const { db } = deps;

  app.get('/academics/criteria', (c) => c.json({ criteria: CRITERIA }));

  app.get('/academics/units', async (c) => {
    const t = c.req.query('template');
    const parsed = t ? template.safeParse(t) : null;
    return c.json({ units: await listUnits(db, parsed?.success ? parsed.data : undefined) });
  });
  app.post('/academics/units', async (c) => c.json({ unit: await createUnit(db, c.get('user'), await parseBody(c, newUnit)) }, 201));
  app.patch('/academics/units/:id', async (c) => {
    const body = await parseBody(c, unitPatch);
    return c.json({ unit: await updateUnit(db, c.get('user'), c.req.param('id'), body) });
  });

  app.get('/exams', async (c) => c.json(await listExams(db)));
  app.get('/exams/plans/:id', async (c) => c.json(await getPlan(db, idParam(c.req.param('id'), 'Lịch kiểm tra'))));
  app.post('/exams/plans', async (c) => c.json({ plan: await createPlan(db, c.get('user'), await parseBody(c, newPlan)) }, 201));
  app.put('/exams/plans/:id/result', async (c) => {
    const body = await parseBody(c, resultBody);
    return c.json({ result: await saveResult(db, c.get('user'), idParam(c.req.param('id'), 'Lịch kiểm tra'), body, deps.today()) });
  });

  app.get('/reports/students', async (c) => c.json({ students: await listReportStudents(db) }));
  app.get('/reports/students/:id', async (c) => c.json(await getStudentReport(db, idParam(c.req.param('id'), 'Học viên'), deps.today())));

  return app;
}
