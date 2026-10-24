import { Hono } from 'hono';
import { z } from 'zod';
import { ROLES } from '../domain/roles.js';
import { errors } from '../errors.js';
import { dateSchema } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { createStaff, listStaff, updateStaff } from '../services/users.js';
import type { AppEnv, Deps } from '../types.js';
import { emailSchema, pinSchema } from './auth.js';

const rolesSchema = z.array(z.enum(ROLES)).min(1, 'Chọn ít nhất một vai trò.');
const nameSchema = z.string().trim().min(1, 'Nhập họ tên.').max(120);

const birthdaySchema = dateSchema.nullable();
const createBody = z.object({ email: emailSchema, name: nameSchema, pin: pinSchema, roles: rolesSchema, birthday: birthdaySchema.optional() });
const patchBody = z
  .object({ name: nameSchema.optional(), roles: rolesSchema.optional(), active: z.boolean().optional(), pin: pinSchema.optional(), birthday: birthdaySchema.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'Không có thay đổi nào.' });

/** Quản lý nhân sự: chỉ Admin (docs/01 — "Quản lý tài khoản"). */
export function staffRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth(deps), requireRole('admin'));

  app.get('/', async (c) => c.json({ staff: await listStaff(deps.db) }));

  app.post('/', async (c) => {
    const body = await parseBody(c, createBody);
    if (body.birthday && body.birthday > deps.today()) throw errors.validation({ birthday: 'Ngày sinh không được ở tương lai.' });
    const created = await createStaff(deps.db, body, c.get('user').id);
    return c.json({ staff: created }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = c.req.param('id');
    if (!/^\d+$/.test(id)) throw errors.notFound('Nhân sự');
    const body = await parseBody(c, patchBody);
    if (body.birthday && body.birthday > deps.today()) throw errors.validation({ birthday: 'Ngày sinh không được ở tương lai.' });
    const updated = await updateStaff(deps.db, id, body, c.get('user').id);
    return c.json({ staff: updated });
  });

  return app;
}
