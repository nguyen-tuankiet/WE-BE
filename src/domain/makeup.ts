export type ProgramGroup = 'baby' | 'foundation' | 'cambridge' | 'ket' | 'pet' | 'ielts' | 'communication' | 'grade10';

export interface MakeupQuota {
  maxCount: number;
  minutes: number;
}

/** Chính sách học bù theo nhóm (docs/02). `null` = chưa có quyết định (Lớp 10). */
export function makeupQuota(group: ProgramGroup): MakeupQuota | null {
  switch (group) {
    case 'baby':
    case 'foundation':
      return { maxCount: 5, minutes: 30 };
    case 'grade10':
      return null;
    default:
      return { maxCount: 2, minutes: 90 };
  }
}
