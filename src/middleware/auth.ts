import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AppConfig } from '../config.js';
import type { Role } from '../domain/roles.js';
import { AppError, errors } from '../errors.js';
import { getSessionUser } from '../services/auth.js';
import type { AppEnv, Deps } from '../types.js';

export const SESSION_COOKIE = 'we_session';

/** Bắt buộc đăng nhập: nạp người dùng + vai trò từ phiên (kiểm quyền luôn ở server, không tin giao diện). */
export function requireAuth({ db }: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) throw errors.unauthenticated();
    const user = await getSessionUser(db, token);
    if (!user) throw errors.unauthenticated();
    c.set('user', user);
    await next();
  };
}

/** Chỉ cho phép người có ít nhất một trong các vai trò. Dùng sau `requireAuth`. */
export function requireRole(...roles: Role[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!c.get('user').roles.some((r) => roles.includes(r))) throw errors.forbidden();
    await next();
  };
}

/** Chặn yêu cầu ghi đến từ trang lạ: nếu có cấu hình CORS_ORIGIN thì `Origin` phải nằm trong danh sách. */
export function originGuard(config: AppConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method);
    const origin = c.req.header('origin');
    if (write && origin && config.corsOrigins.length > 0 && !config.corsOrigins.includes(origin)) {
      throw new AppError(403, 'BAD_ORIGIN', 'Nguồn gửi yêu cầu không được phép.');
    }
    await next();
  };
}
