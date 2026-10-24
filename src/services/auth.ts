import type { Db } from '../db/types.js';
import type { AppConfig } from '../config.js';
import type { Role } from '../domain/roles.js';
import { AppError } from '../errors.js';
import { getDummyHash, newToken, safeEqual, sha256Hex, verifyPin } from '../lib/crypto.js';
import type { AuthUser } from '../types.js';
import { audit } from './audit.js';
import { createStaff, type StaffRow } from './users.js';

const normalizeEmail = (email: string) => email.trim().toLowerCase();

export interface LoginResult {
  token: string;
  user: Omit<AuthUser, 'sessionId'>;
}

const INVALID = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email hoặc mã PIN không đúng.');

/** Đăng nhập bằng email + PIN. Có giới hạn số lần sai; thông báo lỗi không tiết lộ email có tồn tại hay không. */
export async function login(db: Db, config: AppConfig, emailRaw: string, pin: string, userAgent: string | null): Promise<LoginResult> {
  const email = normalizeEmail(emailRaw);

  const fails = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE email = $1 AND success = false AND at > now() - make_interval(mins => $2::int)`,
    [email, config.loginWindowMinutes],
  );
  if (fails.rows[0].n >= config.loginMaxFails) {
    throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Nhập sai quá ${config.loginMaxFails} lần. Vui lòng thử lại sau ${config.loginWindowMinutes} phút.`);
  }

  const found = await db.query<{ id: string; name: string; email: string; pin_hash: string; active: boolean }>(
    'SELECT id::text AS id, name, email, pin_hash, active FROM users WHERE email = $1',
    [email],
  );
  const row = found.rows[0];
  const ok = await verifyPin(row?.pin_hash ?? (await getDummyHash()), pin);
  if (!row || !ok) {
    await db.query('INSERT INTO login_attempts (email, success) VALUES ($1, false)', [email]);
    throw INVALID();
  }
  if (!row.active) throw new AppError(403, 'ACCOUNT_DISABLED', 'Tài khoản đã bị khóa. Liên hệ Admin.');

  const token = newToken();
  const roles = await db.query<{ role: Role }>('SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role', [row.id]);
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at, user_agent)
       VALUES ($1, $2, now() + make_interval(days => $3::int), $4)`,
      [row.id, sha256Hex(token), config.sessionDays, userAgent?.slice(0, 300) ?? null],
    );
    await q.query('DELETE FROM login_attempts WHERE email = $1 AND (success = false OR at < now() - interval \'30 days\')', [email]);
    await audit(q, { userId: row.id, entity: 'session', entityId: row.id, action: 'login' });
  });
  return { token, user: { id: row.id, name: row.name, email: row.email, roles: roles.rows.map((r) => r.role) } };
}

/** Tìm người dùng theo mã phiên; chỉ chấp nhận phiên chưa thu hồi, chưa hết hạn và tài khoản còn hoạt động. */
export async function getSessionUser(db: Db, token: string): Promise<AuthUser | null> {
  const res = await db.query<{ id: string; name: string; email: string; session_id: string }>(
    `SELECT u.id::text AS id, u.name, u.email, s.id::text AS session_id
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active = true`,
    [sha256Hex(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  const roles = await db.query<{ role: Role }>('SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role', [row.id]);
  return { id: row.id, name: row.name, email: row.email, roles: roles.rows.map((r) => r.role), sessionId: row.session_id };
}

export async function logout(db: Db, sessionId: string): Promise<void> {
  await db.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

export interface BootstrapInput {
  secret: string;
  email: string;
  name: string;
  pin: string;
}

/** Tạo Admin đầu tiên bằng `BOOTSTRAP_SECRET`. Chỉ chạy được khi hệ thống chưa có tài khoản nào. */
export async function bootstrapAdmin(db: Db, config: AppConfig, input: BootstrapInput): Promise<StaffRow> {
  if (!config.bootstrapSecret) throw new AppError(404, 'NOT_FOUND', 'Đường dẫn không tồn tại.');
  if (!safeEqual(input.secret, config.bootstrapSecret)) throw new AppError(403, 'FORBIDDEN', 'Mã khởi tạo không đúng.');
  const any = await db.query('SELECT 1 FROM users LIMIT 1');
  if (any.rowCount > 0) throw new AppError(409, 'ALREADY_BOOTSTRAPPED', 'Hệ thống đã có tài khoản, không thể khởi tạo lại.');
  return createStaff(db, { email: input.email, name: input.name, pin: input.pin, roles: ['admin'] }, null);
}
