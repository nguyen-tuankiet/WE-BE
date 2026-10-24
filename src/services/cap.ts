import type { Db } from '../db/types.js';
import { AppError, errors } from '../errors.js';
import type { AuthUser } from '../types.js';
import { audit } from './audit.js';

export const CAP_GROUPS = [
  { value: '2-4-6', label: 'Thứ 2 - 4 - 6', days: [1, 3, 5], slots: ['chieu', 'toi1', 'toi2'], fromOffset: 0, toOffset: 4 },
  { value: '3-5', label: 'Thứ 3 - 5', days: [2, 4], slots: ['chieu', 'toi1', 'toi2'], fromOffset: 1, toOffset: 3 },
  { value: '7', label: 'Thứ 7', days: [6], slots: ['t7a', 't7b'], fromOffset: 5, toOffset: 5 },
] as const;

export interface CapCell {
  slotId: string;
  room: string;
  class: { id: string; name: string; subject: string; assistant: string; maxSize: number };
  teacherName: string | null;
  students: string[];
}

/** Các ô của một nhóm ngày; mỗi ô liên kết lớp thật và danh sách học viên đang học lớp đó. */
export async function getCap(db: Db, group: string): Promise<{ group: string; cells: CapCell[] }> {
  if (!CAP_GROUPS.some((g) => g.value === group)) throw errors.validation({ group: 'Nhóm ngày không hợp lệ.' });
  const res = await db.query<{ slot_id: string; room: string; class_id: string; name: string; subject: string; assistant: string; max_size: number; teacher_name: string | null }>(
    `SELECT cp.slot_id, cp.room, c.id::text AS class_id, c.name, c.subject, c.assistant, c.max_size, u.name AS teacher_name
       FROM class_cap cp JOIN classes c ON c.id = cp.class_id LEFT JOIN users u ON u.id = c.teacher_id
      WHERE cp.cap_group = $1 AND c.active = true ORDER BY cp.slot_id, cp.room`,
    [group],
  );
  const classIds = [...new Set(res.rows.map((r) => r.class_id))];
  const students = await db.query<{ class_id: string; name: string }>(
    `SELECT e.class_id::text AS class_id, s.name FROM enrollments e JOIN students s ON s.id = e.student_id
      WHERE e.status = 'active' AND e.class_id = ANY($1::bigint[]) ORDER BY s.name`,
    [classIds],
  );
  return {
    group,
    cells: res.rows.map((r) => ({
      slotId: r.slot_id,
      room: r.room,
      class: { id: r.class_id, name: r.name, subject: r.subject, assistant: r.assistant, maxSize: r.max_size },
      teacherName: r.teacher_name,
      students: students.rows.filter((s) => s.class_id === r.class_id).map((s) => s.name),
    })),
  };
}

export interface CapInput {
  classId: string;
  group: string;
  slotId: string;
  room: string;
}

/**
 * Xếp một lớp thật vào ô CAP. Chặn: ca không thuộc nhóm ngày, lớp không học vào các ngày của nhóm, trùng phòng, lớp đã có ở ca đó,
 * và giáo viên đã dạy lớp khác cùng nhóm ngày + ca.
 */
export async function addCapSlot(db: Db, user: AuthUser, input: CapInput): Promise<void> {
  const group = CAP_GROUPS.find((g) => g.value === input.group);
  if (!group) throw errors.validation({ group: 'Nhóm ngày không hợp lệ.' });
  if (!(group.slots as readonly string[]).includes(input.slotId)) throw new AppError(422, 'CAP_SLOT_INVALID', 'Ca này không dùng cho nhóm ngày đã chọn.');

  await db.tx(async (q) => {
    const cls = await q.query<{ name: string; active: boolean; teacher_id: string | null; teacher_name: string | null }>(
      'SELECT c.name, c.active, c.teacher_id::text AS teacher_id, u.name AS teacher_name FROM classes c LEFT JOIN users u ON u.id = c.teacher_id WHERE c.id = $1 FOR UPDATE OF c',
      [input.classId],
    );
    if (cls.rowCount === 0) throw errors.notFound('Lớp');
    const c = cls.rows[0];
    if (!c.active) throw new AppError(422, 'CLASS_INACTIVE', 'Lớp đã ngừng hoạt động.');
    const slot = await q.query('SELECT 1 FROM slots WHERE id = $1', [input.slotId]);
    const room = await q.query('SELECT 1 FROM rooms WHERE id = $1', [input.room]);
    if (slot.rowCount === 0) throw errors.validation({ slotId: 'Ca học không tồn tại.' });
    if (room.rowCount === 0) throw errors.validation({ room: 'Phòng không tồn tại.' });

    const days = await q.query<{ weekday: number }>('SELECT weekday::int AS weekday FROM class_weekdays WHERE class_id = $1', [input.classId]);
    const have = new Set(days.rows.map((d) => d.weekday));
    if (!group.days.every((d) => have.has(d))) {
      throw new AppError(422, 'CAP_DAYS_MISMATCH', `Lớp "${c.name}" không học vào các ngày của nhóm ${group.label}.`);
    }

    const roomTaken = await q.query<{ name: string }>(
      'SELECT c.name FROM class_cap cp JOIN classes c ON c.id = cp.class_id WHERE cp.cap_group = $1 AND cp.slot_id = $2 AND cp.room = $3',
      [input.group, input.slotId, input.room],
    );
    if (roomTaken.rowCount > 0) throw new AppError(409, 'CAP_ROOM_CONFLICT', `Phòng ${input.room} đã có lớp "${roomTaken.rows[0].name}" ở ca này.`);

    const same = await q.query('SELECT 1 FROM class_cap WHERE class_id = $1 AND cap_group = $2 AND slot_id = $3', [input.classId, input.group, input.slotId]);
    if (same.rowCount > 0) throw new AppError(409, 'CAP_CLASS_DUPLICATE', 'Lớp này đã có lịch ở ca này.');

    if (c.teacher_id) {
      const busy = await q.query<{ name: string }>(
        `SELECT c2.name FROM class_cap cp JOIN classes c2 ON c2.id = cp.class_id
          WHERE cp.cap_group = $1 AND cp.slot_id = $2 AND c2.teacher_id = $3 AND c2.id <> $4`,
        [input.group, input.slotId, c.teacher_id, input.classId],
      );
      if (busy.rowCount > 0) {
        throw new AppError(409, 'CAP_TEACHER_CONFLICT', `Giáo viên ${c.teacher_name} đã dạy lớp "${busy.rows[0].name}" cùng ca.`);
      }
    }

    await q.query('INSERT INTO class_cap (class_id, cap_group, slot_id, room, created_by) VALUES ($1, $2, $3, $4, $5)', [
      input.classId,
      input.group,
      input.slotId,
      input.room,
      user.id,
    ]);
    await audit(q, { userId: user.id, entity: 'cap', entityId: `${input.group}|${input.slotId}|${input.room}`, action: 'create', detail: { classId: input.classId } });
  });
}

/** Gỡ lớp khỏi ô CAP; lớp và học viên vẫn giữ nguyên. */
export async function removeCapSlot(db: Db, user: AuthUser, input: { group: string; slotId: string; room: string }): Promise<void> {
  await db.tx(async (q) => {
    const del = await q.query<{ class_id: string }>('DELETE FROM class_cap WHERE cap_group = $1 AND slot_id = $2 AND room = $3 RETURNING class_id::text AS class_id', [
      input.group,
      input.slotId,
      input.room,
    ]);
    if (del.rowCount === 0) throw errors.notFound('Ô lịch CAP');
    await audit(q, { userId: user.id, entity: 'cap', entityId: `${input.group}|${input.slotId}|${input.room}`, action: 'delete', detail: { classId: del.rows[0].class_id } });
  });
}
