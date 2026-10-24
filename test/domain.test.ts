import { describe, expect, it } from 'vitest';
import { PROGRAMS } from '../src/domain/catalog.js';
import { addDays, isIsoDate, weekdayOf } from '../src/domain/dates.js';
import { makeupQuota } from '../src/domain/makeup.js';
import { generateSchedule } from '../src/domain/schedule.js';

describe('ngày nghiệp vụ', () => {
  it('cộng ngày và tìm thứ trong tuần không lệch múi giờ', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekdayOf('2026-10-22')).toBe(4); // Thứ 5
    expect(weekdayOf('2026-10-25')).toBe(0); // Chủ nhật
  });

  it('kiểm tra định dạng YYYY-MM-DD và ngày có thật', () => {
    expect(isIsoDate('2026-10-22')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('22/10/2026')).toBe(false);
  });
});

describe('sinh lịch buổi chính (docs/02)', () => {
  it('đủ số buổi theo ngày học 2-4-6 (Thứ 2, 4, 6)', () => {
    const s = generateSchedule({ startDate: '2026-10-05', weekdays: [1, 3, 5], totalSessions: 6 });
    expect(s).toEqual(['2026-10-05', '2026-10-07', '2026-10-09', '2026-10-12', '2026-10-14', '2026-10-16']);
  });

  it('khóa 36 buổi không vắng có đúng 36 buổi chính', () => {
    expect(generateSchedule({ startDate: '2026-09-07', weekdays: [1, 3, 5], totalSessions: 36 })).toHaveLength(36);
  });

  it('ngày trung tâm nghỉ làm dời buổi nhưng vẫn đủ định mức', () => {
    const s = generateSchedule({ startDate: '2026-10-05', weekdays: [1, 3, 5], totalSessions: 4, closedDates: ['2026-10-07'] });
    expect(s).toEqual(['2026-10-05', '2026-10-09', '2026-10-12', '2026-10-14']);
  });

  it('khoảng bảo lưu tạm dừng lịch chính', () => {
    const s = generateSchedule({
      startDate: '2026-10-05',
      weekdays: [1, 3, 5],
      totalSessions: 3,
      pausedRanges: [{ from: '2026-10-06', to: '2026-10-12' }],
    });
    expect(s).toEqual(['2026-10-05', '2026-10-14', '2026-10-16']);
  });
});

describe('chính sách học bù theo nhóm (docs/02)', () => {
  it('Baby/Foundation 5×30 phút; level khác 2×90 phút; Lớp 10 chưa có chính sách', () => {
    expect(makeupQuota('baby')).toEqual({ maxCount: 5, minutes: 30 });
    expect(makeupQuota('foundation')).toEqual({ maxCount: 5, minutes: 30 });
    expect(makeupQuota('ielts')).toEqual({ maxCount: 2, minutes: 90 });
    expect(makeupQuota('cambridge')).toEqual({ maxCount: 2, minutes: 90 });
    expect(makeupQuota('grade10')).toBeNull();
  });
});

describe('danh mục chương trình (docs/05)', () => {
  it('có đúng 46 gói, mã không trùng', () => {
    expect(PROGRAMS).toHaveLength(46);
    expect(new Set(PROGRAMS.map((p) => p.id)).size).toBe(46);
  });

  it('phân bổ theo nhóm 1/12/6/4/6/8/6/3', () => {
    const count = (g: string) => PROGRAMS.filter((p) => p.group === g).length;
    expect(['baby', 'foundation', 'cambridge', 'ket', 'pet', 'ielts', 'communication', 'grade10'].map(count)).toEqual([1, 12, 6, 4, 6, 8, 6, 3]);
  });

  it('gói theo tháng (Lớp 10) chưa có số buổi để Admin xác nhận', () => {
    expect(PROGRAMS.filter((p) => p.group === 'grade10').every((p) => p.sessions === null)).toBe(true);
  });
});
