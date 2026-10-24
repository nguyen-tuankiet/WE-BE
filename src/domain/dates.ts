/** Ngày nghiệp vụ là chuỗi `YYYY-MM-DD` (giờ Việt Nam, không quy đổi múi giờ). Mọi phép tính dùng UTC để không lệch ngày. */
const DAY_MS = 86_400_000;

const toMs = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, n: number): string => fromMs(toMs(date) + n * DAY_MS);

/** 0 = Chủ nhật … 6 = Thứ 7 (giống `Date.getDay`). */
export const weekdayOf = (date: string): number => new Date(toMs(date)).getUTCDay();

export const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && fromMs(toMs(s)) === s;

export const diffDays = (a: string, b: string): number => Math.round((toMs(a) - toMs(b)) / DAY_MS);

/** Ngày hiện tại theo giờ Việt Nam (UTC+7). */
export const todayVN = (): string => fromMs(Date.now() + 7 * 3_600_000);
