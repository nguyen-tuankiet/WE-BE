import type { ProgramGroup } from './makeup.js';

export interface ProgramSeed {
  id: string;
  group: ProgramGroup;
  name: string;
  tuition: number;
  /** null = gói tính theo tháng, Admin phải xác nhận số buổi thực tế */
  sessions: number | null;
  maxSize: number;
  unitTemplate: 'baby' | 'foundation' | 'cambridge' | null;
  note?: string;
}

/** Danh mục 46 gói theo các tờ giá của trung tâm (docs/05). Học phí/số buổi là dữ liệu chỉnh sửa được sau khi seed. */
export const PROGRAMS: ProgramSeed[] = [];

function add(
  id: string,
  group: ProgramGroup,
  name: string,
  tuition: number,
  sessions: number | null,
  maxSize = 10,
  unitTemplate: ProgramSeed['unitTemplate'] = null,
  note?: string,
) {
  PROGRAMS.push({ id, group, name, tuition, sessions, maxSize, unitTemplate, note });
}

add('baby-stars', 'baby', 'Baby Stars', 6_000_000, 36, 10, 'baby', 'Bé 4–6 tuổi hoặc chưa đọc viết chữ cái');

const kids: [string, number, string[]][] = [
  ['Smart Explorers', 6_100_000, ['SK1.1-6', 'SK1.7-9 · SK2.1-3', '']],
  ['Smart Learners', 6_200_000, ['SK2.4-9', 'SK3.1-6', '']],
  ['Smart Performers', 6_300_000, ['SK3.7-9 · SK4.1-3', 'SK4.4-9', '']],
  ['Smart Achievers', 6_400_000, ['SK5.1-6', 'SK5.7-9 · SK6.1-3', '']],
];
for (const [name, tuition, sk] of kids) {
  for (let i = 1; i <= 3; i++) {
    add(`${name.toLowerCase().replace(/\s/g, '-')}-${i}`, 'foundation', `${name} ${i}`, tuition, 24, 10, 'foundation', sk[i - 1] || undefined);
  }
}

for (const [name, tuition] of [
  ['Starters', 9_300_000],
  ['Movers', 9_400_000],
  ['Flyers', 9_500_000],
] as const) {
  add(`${name.toLowerCase()}-nen-tang`, 'cambridge', `${name} Nền tảng`, tuition, 36, 10, 'cambridge');
  add(`${name.toLowerCase()}-luyen-de`, 'cambridge', `${name} Luyện đề`, tuition, 36, 10, 'cambridge');
}

for (let i = 1; i <= 2; i++) add(`ket-foundation-${i}`, 'ket', `KET Foundation ${i}`, 10_000_000, 36, 10, 'cambridge');
for (let i = 1; i <= 2; i++) add(`ket-intensive-${i}`, 'ket', `KET Intensive ${i}`, 10_500_000, 36, 10, 'cambridge');
for (let i = 1; i <= 3; i++) add(`pet-foundation-${i}`, 'pet', `PET Foundation ${i}`, 11_000_000, 36, 10, 'cambridge');
for (let i = 1; i <= 3; i++) add(`pet-intensive-${i}`, 'pet', `PET Intensive ${i}`, 11_500_000, 36, 10, 'cambridge');

add('ielts-we101', 'ielts', 'IELTS Foundation WE101', 7_500_000, 36);
add('ielts-we102', 'ielts', 'IELTS Foundation WE102', 8_700_000, 36);
add('ielts-we103', 'ielts', 'IELTS Foundation WE103', 9_800_000, 36);
add('pre-ielts-1', 'ielts', 'Pre-IELTS 1', 12_500_000, 36);
add('pre-ielts-2', 'ielts', 'Pre-IELTS 2', 13_700_000, 36);
add('ielts-50-55', 'ielts', 'IELTS 5.0–5.5 (4 kỹ năng)', 14_800_000, 42);
add('ielts-60-4', 'ielts', 'IELTS 6.0+ (4 kỹ năng)', 16_800_000, 42);
add('ielts-60-2', 'ielts', 'IELTS 6.0+ (2 kỹ năng)', 13_250_000, 25);

for (const [id, name, group, solo] of [
  ['we201', 'WE201 Giao tiếp sơ cấp', 6_000_000, 8_500_000],
  ['we202', 'WE202 Giao tiếp trung cấp', 6_500_000, 8_700_000],
  ['we203', 'WE203 Giao tiếp chuyên sâu', 7_000_000, 9_000_000],
] as const) {
  add(`${id}-nhom`, 'communication', `${name} · lớp nhóm`, group, 24, 8);
  add(`${id}-1k1`, 'communication', `${name} · một kèm một`, solo, 24, 1);
}

add('lop10-gd1', 'grade10', 'Lớp 10 · Giai đoạn 1: Hoàn tất lớp 9', 13_200_000, null, 10, null, '4,5 tháng, 3 buổi/tuần');
add('lop10-gd2', 'grade10', 'Lớp 10 · Giai đoạn 2: Tổng ôn lớp 6–9', 9_150_000, null, 10, null, '3 tháng, 3 buổi/tuần');
add('lop10-gd3', 'grade10', 'Lớp 10 · Giai đoạn 3: Luyện thi giải đề', 9_150_000, null, 10, null, '3 tháng, 3 buổi/tuần');

export const SLOTS = [
  { id: 'chieu', label: 'Chiều', timeRange: '15:00–16:30' },
  { id: 'toi1', label: 'Tối 1', timeRange: '17:00–18:30' },
  { id: 'toi2', label: 'Tối 2', timeRange: '19:15–20:45' },
  { id: 't7a', label: 'Chiều T7 (1)', timeRange: '14:30–16:00' },
  { id: 't7b', label: 'Chiều T7 (2)', timeRange: '16:00–17:30' },
];

export const ROOMS = [
  { id: '101', floor: 'Lầu 1' },
  { id: '102', floor: 'Lầu 1' },
  { id: '103', floor: 'Lầu 1' },
  { id: 'Tiếp khách', floor: 'Lầu 1' },
  { id: '202', floor: 'Lầu 2' },
  { id: '203', floor: 'Lầu 2' },
  { id: '204', floor: 'Lầu 2' },
];

/** Cài đặt mặc định (xem docs/08: các mốc này chưa được chốt chính thức nên cho phép đổi). */
export const DEFAULT_SETTINGS = {
  reminder_days: 30,
  teacher_edit_days: 3,
  redflag_below: 60,
  good_above: 80,
};
