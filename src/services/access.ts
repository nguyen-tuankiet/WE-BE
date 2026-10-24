import type { Role } from '../domain/roles.js';

export const isManagement = (roles: Role[]) => roles.includes('admin') || roles.includes('manager');

/** Giáo viên thuần (không phải Admin/Manager) chỉ thao tác lớp được phân công (docs/01). */
export const isTeacherOnly = (roles: Role[]) => roles.includes('teacher') && !isManagement(roles);

/** Liên hệ riêng và học phí chỉ Admin/Manager được xem — kiểm ở server, không dựa vào giao diện. */
export const canSeePrivate = isManagement;
