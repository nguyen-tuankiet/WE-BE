export const ROLES = ['admin', 'manager', 'teacher', 'inspector'] as const;
export type Role = (typeof ROLES)[number];
