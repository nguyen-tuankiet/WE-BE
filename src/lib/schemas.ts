import { z } from 'zod';
import { isIsoDate } from '../domain/dates.js';
import { errors } from '../errors.js';

export const dateSchema = z.string().refine(isIsoDate, 'Ngày không hợp lệ (định dạng YYYY-MM-DD).');
export const weekdaysSchema = z.array(z.number().int().min(0).max(6)).min(1, 'Chọn ít nhất một ngày học.');
export const idSchema = z.string().regex(/^\d+$/, 'Mã không hợp lệ.');
export const nonEmpty = (label: string, max = 200) => z.string().trim().min(1, `Nhập ${label}.`).max(max);

/** Mã trong đường dẫn phải là số nguyên dương; sai → 404 (không tiết lộ định dạng nội bộ). */
export function idParam(value: string, what: string): string {
  if (!/^\d+$/.test(value)) throw errors.notFound(what);
  return value;
}
