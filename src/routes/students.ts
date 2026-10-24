import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors.js';
import { dateSchema, idParam, nonEmpty } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createStudent, getStudentProfile, listStudents, setStudentStar, updateStudent } from '../services/students.js';
import type { AppEnv, Deps } from '../types.js';

const phoneSchema = z.string().trim().regex(/^(0\d{9})?$/, 'Số điện thoại gồm 10 chữ số, bắt đầu bằng 0.');
const text = (max = 300) => z.string().trim().max(max);

const newStudent = z.object({
  name: nonEmpty('họ tên', 120),
  birthday: dateSchema,
  guardian: text().default(''),
  phone: phoneSchema.default(''),
  address: text().default(''),
  tuitionMode: text(60).default(''),
  note: text(1000).default(''),
});

const studentPatch = z
  .object({
    name: nonEmpty('họ tên', 120).optional(),
    birthday: dateSchema.optional(),
    guardian: text().optional(),
    phone: phoneSchema.optional(),
    address: text().optional(),
    tuitionMode: text(60).optional(),
    note: text(1000).optional(),
    nextCourse: text(120).optional(),
    status: z.enum(['active', 'left']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Không có thay đổi nào.' });

const starBody = z.object({
  star: z.boolean(),
  redflagBelow: z.number().int().min(0).max(100).optional(),
  goodAbove: z.number().int().min(0).max(100).optional(),
});

export function studentRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;
  app.use('*', requireAuth(deps));
  const manage = requireRole('admin', 'manager');

  app.get('/', async (c) => c.json({ students: await listStudents(db, c.get('user')) }));

  app.get('/:id', async (c) => {
    const id = idParam(c.req.param('id'), 'Học viên');
    return c.json(await getStudentProfile(db, c.get('user'), id, deps.today()));
  });

  app.post('/', manage, async (c) => {
    const body = await parseBody(c, newStudent);
    if (body.birthday > deps.today()) throw errors.validation({ birthday: 'Ngày sinh không được ở tương lai.' });
    return c.json({ student: await createStudent(db, c.get('user'), body) }, 201);
  });

  app.patch('/:id/star', requireRole('admin', 'manager', 'inspector'), async (c) => {
    const id = idParam(c.req.param('id'), 'Học viên');
    const body = await parseBody(c, starBody);
    return c.json({ student: await setStudentStar(db, c.get('user'), id, body) });
  });

  app.patch('/:id', manage, async (c) => {
    const id = idParam(c.req.param('id'), 'Học viên');
    const body = await parseBody(c, studentPatch);
    if (body.birthday && body.birthday > deps.today()) throw errors.validation({ birthday: 'Ngày sinh không được ở tương lai.' });
    return c.json({ student: await updateStudent(db, c.get('user'), id, body) });
  });

  return app;
}
