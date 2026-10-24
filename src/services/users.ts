import type { Queryable } from '../db/types.js';
import type { Db } from '../db/types.js';
import { ROLES, type Role } from '../domain/roles.js';
import { AppError, errors } from '../errors.js';
import { hashPin } from '../lib/crypto.js';
import { audit } from './audit.js';

export interface StaffRow {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  active: boolean;
  /** YYYY-MM-DD, null nếu chưa nhập */
  birthday: string | null;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

async function rolesOf(q: Queryable, userId: string): Promise<Role[]> {
  const res = await q.query<{ role: Role }>('SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role', [userId]);
  return res.rows.map((r) => r.role);
}

async function setRoles(q: Queryable, userId: string, roles: Role[]) {
  await q.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
  for (const role of new Set(roles)) {
    if (!ROLES.includes(role)) throw errors.validation({ roles: 'Vai trò không hợp lệ.' });
    await q.query('INSERT INTO user_roles (user_id, role) VALUES ($1, $2)', [userId, role]);
  }
}

export async function listStaff(db: Db): Promise<StaffRow[]> {
  const users = await db.query<{ id: string; name: string; email: string; active: boolean; birthday: string | null }>(
    'SELECT id::text AS id, name, email, active, birthday::text AS birthday FROM users ORDER BY id',
  );
  const roles = await db.query<{ user_id: string; role: Role }>('SELECT user_id::text AS user_id, role FROM user_roles ORDER BY role');
  return users.rows.map((u) => ({ ...u, roles: roles.rows.filter((r) => r.user_id === u.id).map((r) => r.role) }));
}

export interface NewStaff {
  email: string;
  name: string;
  pin: string;
  roles: Role[];
  birthday?: string | null;
}

/** Tạo tài khoản + vai trò trong một giao dịch. `actorId` null = tạo qua bootstrap. */
export async function createStaff(db: Db, input: NewStaff, actorId: string | null): Promise<StaffRow> {
  const email = normalizeEmail(input.email);
  const pinHash = await hashPin(input.pin);
  return db.tx(async (q) => {
    const exists = await q.query('SELECT 1 FROM users WHERE email = $1', [email]);
    if (exists.rowCount > 0) throw new AppError(409, 'EMAIL_EXISTS', 'Email này đã có tài khoản.');
    const res = await q.query<{ id: string }>('INSERT INTO users (email, name, pin_hash, birthday) VALUES ($1, $2, $3, $4::date) RETURNING id::text AS id', [
      email,
      input.name.trim(),
      pinHash,
      input.birthday ?? null,
    ]);
    const id = res.rows[0].id;
    await setRoles(q, id, input.roles);
    await audit(q, { userId: actorId, entity: 'user', entityId: id, action: 'create', detail: { email, roles: input.roles } });
    return { id, name: input.name.trim(), email, roles: await rolesOf(q, id), active: true, birthday: input.birthday ?? null };
  });
}

export interface StaffPatch {
  name?: string;
  roles?: Role[];
  active?: boolean;
  pin?: string;
  /** null = xóa ngày sinh */
  birthday?: string | null;
}

/** Sửa tài khoản. Khóa tài khoản hoặc đổi PIN thì thu hồi mọi phiên đăng nhập đang có (NT16). */
export async function updateStaff(db: Db, id: string, patch: StaffPatch, actorId: string): Promise<StaffRow> {
  const pinHash = patch.pin ? await hashPin(patch.pin) : undefined;
  return db.tx(async (q) => {
    const cur = await q.query<{ id: string; name: string; email: string; active: boolean }>(
      'SELECT id::text AS id, name, email, active FROM users WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (cur.rowCount === 0) throw errors.notFound('Nhân sự');

    if (id === actorId) {
      const losesAdmin = patch.roles !== undefined && !patch.roles.includes('admin');
      if (patch.active === false || losesAdmin) {
        throw new AppError(422, 'CANNOT_LOCK_SELF', 'Không thể tự khóa tài khoản hoặc tự bỏ quyền Admin của mình.');
      }
    }

    if (patch.name !== undefined) await q.query('UPDATE users SET name = $2, updated_at = now() WHERE id = $1', [id, patch.name.trim()]);
    if (patch.active !== undefined) await q.query('UPDATE users SET active = $2, updated_at = now() WHERE id = $1', [id, patch.active]);
    if (patch.birthday !== undefined) await q.query('UPDATE users SET birthday = $2::date, updated_at = now() WHERE id = $1', [id, patch.birthday]);
    if (pinHash) await q.query('UPDATE users SET pin_hash = $2, updated_at = now() WHERE id = $1', [id, pinHash]);
    if (patch.roles !== undefined) await setRoles(q, id, patch.roles);

    if (patch.active === false || pinHash) {
      await q.query('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
    }
    await audit(q, {
      userId: actorId,
      entity: 'user',
      entityId: id,
      action: 'update',
      detail: { name: patch.name, roles: patch.roles, active: patch.active, birthday: patch.birthday, pinChanged: !!pinHash },
    });

    const row = await q.query<{ id: string; name: string; email: string; active: boolean; birthday: string | null }>(
      'SELECT id::text AS id, name, email, active, birthday::text AS birthday FROM users WHERE id = $1',
      [id],
    );
    return { ...row.rows[0], roles: await rolesOf(q, id) };
  });
}
