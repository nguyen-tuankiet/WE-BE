import type { Queryable } from '../db/types.js';

export interface AuditEntry {
  userId: string | null;
  entity: string;
  entityId: string;
  action: string;
  detail?: Record<string, unknown>;
}

/** Ghi nhật ký thao tác; gọi trong cùng giao dịch với thao tác chính để hai bên luôn khớp nhau. */
export async function audit(q: Queryable, e: AuditEntry): Promise<void> {
  await q.query('INSERT INTO audit_log (user_id, entity, entity_id, action, detail) VALUES ($1, $2, $3, $4, $5)', [
    e.userId,
    e.entity,
    e.entityId,
    e.action,
    e.detail ? JSON.stringify(e.detail) : null,
  ]);
}
