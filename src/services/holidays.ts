import type { Db } from '../db/types.js';
import { AppError } from '../errors.js';
import { audit } from './audit.js';
import { rescheduleFrom } from './enrollments.js';

export interface Holiday {
  date: string;
  reason: string;
}

export async function listHolidays(db: Db): Promise<Holiday[]> {
  const res = await db.query<Holiday>('SELECT date::text AS date, reason FROM holidays ORDER BY date');
  return res.rows;
}

/**
 * Ghi nhận ngày trung tâm nghỉ và dời lịch buổi chính của các khóa bị ảnh hưởng, vẫn đủ định mức.
 * Buổi bị hủy không phải buổi vắng của học viên (docs/02). Ngày đã có điểm danh phải được đối chiếu/sửa trước khi đặt là ngày nghỉ;
 * các buổi đã có điểm danh ở những ngày khác không bao giờ bị dời.
 */
export async function addHoliday(db: Db, h: Holiday, actorId: string): Promise<Holiday & { rescheduledEnrollments: number }> {
  return db.tx(async (q) => {
    const dup = await q.query('SELECT 1 FROM holidays WHERE date = $1::date', [h.date]);
    if (dup.rowCount > 0) throw new AppError(409, 'HOLIDAY_EXISTS', 'Ngày này đã được ghi nhận nghỉ.');
    const recorded = await q.query('SELECT 1 FROM attendance WHERE date = $1::date LIMIT 1', [h.date]);
    if (recorded.rowCount > 0) {
      throw new AppError(409, 'HOLIDAY_HAS_ATTENDANCE', 'Ngày này đã có điểm danh. Hãy đối chiếu và sửa điểm danh trước khi đặt là ngày nghỉ.');
    }
    await q.query('INSERT INTO holidays (date, reason, created_by) VALUES ($1::date, $2, $3)', [h.date, h.reason.trim(), actorId]);
    const n = await rescheduleFrom(q, h.date);
    await audit(q, { userId: actorId, entity: 'holiday', entityId: h.date, action: 'create', detail: { reason: h.reason, rescheduledEnrollments: n } });
    return { date: h.date, reason: h.reason.trim(), rescheduledEnrollments: n };
  });
}

export async function removeHoliday(db: Db, date: string, actorId: string): Promise<{ rescheduledEnrollments: number }> {
  return db.tx(async (q) => {
    const del = await q.query('DELETE FROM holidays WHERE date = $1::date RETURNING 1', [date]);
    if (del.rowCount === 0) throw new AppError(404, 'NOT_FOUND', 'Ngày nghỉ không tồn tại.');
    const n = await rescheduleFrom(q, date);
    await audit(q, { userId: actorId, entity: 'holiday', entityId: date, action: 'delete', detail: { rescheduledEnrollments: n } });
    return { rescheduledEnrollments: n };
  });
}
