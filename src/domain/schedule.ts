import { addDays, weekdayOf } from './dates.js';

export interface ScheduleInput {
  startDate: string;
  /** 0 = Chủ nhật … 6 = Thứ 7 */
  weekdays: number[];
  totalSessions: number;
  /** Lịch theo giai đoạn (đã sắp xếp tăng dần theo `from`); có thì dùng thay cho `weekdays`: ngày nào thuộc giai đoạn nào dùng ngày học của giai đoạn đó. */
  segments?: { from: string; weekdays: number[] }[];
  closedDates?: Iterable<string>;
  /** Khoảng bảo lưu hợp lệ [từ, đến]: lịch chính tạm dừng. */
  pausedRanges?: { from: string; to: string }[];
}

/** Sinh lịch buổi chính từ ngày bắt đầu: bỏ ngày trung tâm nghỉ và khoảng bảo lưu, dời để vẫn đủ số buổi. */
export function generateSchedule(input: ScheduleInput): string[] {
  const closed = new Set(input.closedDates ?? []);
  const paused = input.pausedRanges ?? [];
  const fixedDays = new Set(input.weekdays);
  const segments = input.segments && input.segments.length > 0 ? input.segments : null;
  const daysOn = (date: string): Set<number> => {
    if (!segments) return fixedDays;
    let seg = segments[0];
    for (const s of segments) if (s.from <= date) seg = s;
    return new Set(seg.weekdays);
  };
  const out: string[] = [];
  let date = input.startDate;
  for (let guard = 0; out.length < input.totalSessions && guard < 3000; guard++) {
    const isPaused = paused.some((r) => date >= r.from && date <= r.to);
    if (daysOn(date).has(weekdayOf(date)) && !closed.has(date) && !isPaused) out.push(date);
    date = addDays(date, 1);
  }
  return out;
}
