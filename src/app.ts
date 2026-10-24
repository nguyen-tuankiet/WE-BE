import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { AppError } from './errors.js';
import { originGuard, requireAuth } from './middleware/auth.js';
import { academicsRoutes } from './routes/academics.js';
import { attendanceRoutes } from './routes/attendance.js';
import { authRoutes } from './routes/auth.js';
import { catalogRoutes } from './routes/catalog.js';
import { classRoutes } from './routes/classes.js';
import { enrollmentRoutes } from './routes/enrollments.js';
import { makeupRoutes } from './routes/makeups.js';
import { opsRoutes } from './routes/ops.js';
import { reserveRoutes } from './routes/reserves.js';
import { staffRoutes } from './routes/staff.js';
import { studentRoutes } from './routes/students.js';
import type { AppEnv, Deps } from './types.js';

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  if (deps.config.corsOrigins.length > 0) {
    app.use('*', cors({ origin: deps.config.corsOrigins, credentials: true, allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], allowHeaders: ['Content-Type'] }));
  }
  app.use('/api/*', originGuard(deps.config));

  /** Chỉ báo server còn sống, KHÔNG đụng DB: dùng cho dịch vụ ping giữ máy chủ thức (không đánh thức Neon). */
  app.get('/ping', (c) => c.json({ ok: true }));

  app.get('/health', async (c) => {
    try {
      await deps.db.query('SELECT 1');
      return c.json({ ok: true, today: deps.today() });
    } catch {
      return c.json({ ok: false, error: { code: 'DB_UNAVAILABLE', message: 'Không kết nối được cơ sở dữ liệu.' } }, 503);
    }
  });

  app.route('/api/v1/auth', authRoutes(deps));
  app.route('/api/v1/staff', staffRoutes(deps));
  app.route('/api/v1/students', studentRoutes(deps));
  app.route('/api/v1/classes', classRoutes(deps));
  app.route('/api/v1/enrollments', enrollmentRoutes(deps));
  app.route('/api/v1/attendance', attendanceRoutes(deps));
  app.route('/api/v1/makeups', makeupRoutes(deps));
  app.route('/api/v1', academicsRoutes(deps));
  app.route('/api/v1', opsRoutes(deps));
  app.route('/api/v1/reserves', reserveRoutes(deps));
  app.route('/api/v1', catalogRoutes(deps));
  app.get('/api/v1/me', requireAuth(deps), (c) => {
    const { sessionId: _sessionId, ...user } = c.get('user');
    return c.json({ user });
  });

  app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Đường dẫn không tồn tại.' } }, 404));
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json({ error: { code: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) } }, err.status);
    }
    console.error('Lỗi không xác định:', err);
    return c.json({ error: { code: 'INTERNAL', message: 'Có lỗi hệ thống. Vui lòng thử lại sau.' } }, 500);
  });

  return app;
}
