export type UnitTemplate = 'baby' | 'foundation' | 'cambridge';
export type Rating = 'good' | 'average' | 'redflag';

export interface Criterion {
  key: string;
  label: string;
  kind: 'score' | 'choice';
  options?: string[];
  /** Chỉ báo cáo riêng, không tính vào điểm tổng */
  reportOnly?: boolean;
}

const CLEAR = ['clear', 'unclear'];
const OK = ['ok', 'no'];

/** Tiêu chí theo mẫu phiếu (docs/03). Điểm 0–100; Vocabulary lưu dưới dạng % số từ đạt. */
export const CRITERIA: Record<UnitTemplate, Criterion[]> = {
  baby: [
    { key: 'spelling', label: 'Spelling', kind: 'score' },
    { key: 'writing', label: 'Writing', kind: 'score' },
  ],
  foundation: [
    { key: 'vocabulary', label: 'Vocabulary (số từ đạt)', kind: 'score' },
    { key: 'communication', label: 'Communication', kind: 'score' },
    { key: 'pronunciation', label: 'Pronunciation', kind: 'choice', options: CLEAR, reportOnly: true },
  ],
  cambridge: [
    { key: 'pattern', label: 'Pattern', kind: 'score' },
    { key: 'freestyle', label: 'Freestyle', kind: 'score' },
    { key: 'pron1', label: 'Pronunciation 1', kind: 'choice', options: CLEAR, reportOnly: true },
    { key: 'pron2', label: 'Pronunciation 2', kind: 'choice', options: CLEAR, reportOnly: true },
    { key: 'gram1', label: 'Ngữ pháp: One / Many', kind: 'choice', options: OK, reportOnly: true },
    { key: 'gram2', label: 'Ngữ pháp: Am / Is / Are', kind: 'choice', options: OK, reportOnly: true },
  ],
};

export interface Thresholds {
  redflagBelow: number;
  goodAbove: number;
}

export function classify(percent: number, t: Thresholds): Rating {
  if (percent < t.redflagBelow) return 'redflag';
  if (percent > t.goodAbove) return 'good';
  return 'average';
}

export type UnitValues = Record<string, number | string | null | undefined>;

/** Kiểm tra giá trị một Unit: đủ mọi trường bắt buộc, điểm trong 0–100, lựa chọn hợp lệ. Trả về lỗi theo khóa tiêu chí. */
export function validateUnitValues(template: UnitTemplate, values: UnitValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const c of CRITERIA[template]) {
    const v = values[c.key];
    if (v === null || v === undefined || v === '') {
      errors[c.key] = 'Thiếu trường bắt buộc.';
    } else if (c.kind === 'score') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) errors[c.key] = 'Điểm phải từ 0 đến 100.';
    } else if (typeof v !== 'string' || !c.options?.includes(v)) {
      errors[c.key] = 'Lựa chọn không hợp lệ.';
    }
  }
  for (const key of Object.keys(values)) {
    if (!CRITERIA[template].some((c) => c.key === key)) errors[key] = 'Tiêu chí không thuộc mẫu phiếu này.';
  }
  return errors;
}

export interface Summary {
  percent: number;
  overall: Rating;
  perCriterion: { key: string; label: string; percent: number; rating: Rating }[];
}

/**
 * Điểm tổng = trung bình % các tiêu chí điểm (mỗi tiêu chí là trung bình qua các Unit). Có tiêu chí Redflag thì kết quả chung
 * là Redflag; nếu không, trên ngưỡng Good là Good, còn lại Average. Pronunciation và ngữ pháp chỉ báo cáo riêng.
 */
export function summarize(template: UnitTemplate, units: { values: UnitValues }[], t: Thresholds): Summary {
  const scored = CRITERIA[template].filter((c) => c.kind === 'score');
  const perCriterion = scored.map((c) => {
    const vals = units.map((u) => Number(u.values[c.key] ?? 0));
    const percent = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    return { key: c.key, label: c.label, percent, rating: classify(percent, t) };
  });
  const percent = perCriterion.length ? perCriterion.reduce((a, c) => a + c.percent, 0) / perCriterion.length : 0;
  const anyRed = perCriterion.some((c) => c.rating === 'redflag');
  const overall: Rating = anyRed ? 'redflag' : percent > t.goodAbove ? 'good' : 'average';
  return { percent, overall, perCriterion };
}
