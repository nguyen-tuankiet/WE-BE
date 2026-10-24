import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { parseBody } from '../lib/validate.js';
import { requireAuth, SESSION_COOKIE } from '../middleware/auth.js';
import { bootstrapAdmin, login, logout } from '../services/auth.js';
import type { AppEnv, Deps } from '../types.js';

export const emailSchema = z.string().trim().toLowerCase().email('Email chưa hợp lệ.');
export const pinSchema = z.string().regex(/^\d{4,6}$/, 'PIN gồm 4–6 chữ số.');

const loginBody = z.object({ email: emailSchema, pin: pinSchema });
const bootstrapBody = z.object({
  secret: z.string().min(1, 'Nhập mã khởi tạo.'),
  email: emailSchema,
  name: z.string().trim().min(1, 'Nhập họ tên.').max(120),
  pin: pinSchema,
});

export function authRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db, config } = deps;

  app.post('/login', async (c) => {
    const body = await parseBody(c, loginBody);
    const result = await login(db, config, body.email, body.pin, c.req.header('user-agent') ?? null);
    setCookie(c, SESSION_COOKIE, result.token, {
      httpOnly: true,
      secure: config.isProd || config.sameSite === 'None',
      sameSite: config.sameSite,
      path: '/',
      maxAge: config.sessionDays * 86_400,
    });
    return c.json({ user: result.user });
  });

  app.post('/logout', requireAuth(deps), async (c) => {
    await logout(db, c.get('user').sessionId);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.post('/bootstrap', async (c) => {
    const body = await parseBody(c, bootstrapBody);
    const admin = await bootstrapAdmin(db, config, body);
    return c.json({ user: admin }, 201);
  });

  return app;
}
