-- 0005: học vụ — khung nội dung (Unit), lịch kiểm tra, kết quả chấm.
-- Kết quả LUÔN lưu kèm bản chụp nội dung Unit đã dùng và ngưỡng áp dụng lúc chấm,
-- nên sửa khung chương trình hoặc dấu sao về sau không làm đổi báo cáo cũ.

CREATE TABLE curriculum_units (
  id          text PRIMARY KEY,
  template    text    NOT NULL,
  name        text    NOT NULL,
  topic       text    NOT NULL DEFAULT '',
  words       jsonb   NOT NULL DEFAULT '[]'::jsonb,
  patterns    jsonb   NOT NULL DEFAULT '[]'::jsonb,
  sort_order  int     NOT NULL DEFAULT 0,
  active      boolean NOT NULL DEFAULT true,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_units_template_valid CHECK (template IN ('baby', 'foundation', 'cambridge'))
);

CREATE TABLE exam_plans (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id bigint NOT NULL REFERENCES enrollments (id),
  planned_date  date   NOT NULL,
  status        text   NOT NULL DEFAULT 'pending',
  created_by    bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_plans_status_valid CHECK (status IN ('pending', 'done'))
);
CREATE INDEX exam_plans_enrollment_idx ON exam_plans (enrollment_id);
CREATE INDEX exam_plans_status_idx ON exam_plans (status, planned_date);

CREATE TABLE exam_plan_units (
  plan_id    bigint NOT NULL REFERENCES exam_plans (id) ON DELETE CASCADE,
  unit_id    text   NOT NULL REFERENCES curriculum_units (id),
  sort_order int    NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, unit_id)
);

-- Mỗi lịch chỉ có MỘT kết quả (lưu lại = cập nhật, không tạo bản trùng).
CREATE TABLE exam_results (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id        bigint NOT NULL REFERENCES exam_plans (id),
  enrollment_id  bigint NOT NULL REFERENCES enrollments (id),
  date           date   NOT NULL,
  examiner_id    bigint REFERENCES users (id) ON DELETE SET NULL,
  examiner_name  text   NOT NULL,
  comment        text   NOT NULL DEFAULT '',
  support        text   NOT NULL DEFAULT '',
  overall        text   NOT NULL,
  percent        numeric(5, 2) NOT NULL,
  thresholds     jsonb  NOT NULL,
  snapshot       jsonb  NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exam_results_plan_unique UNIQUE (plan_id),
  CONSTRAINT exam_results_overall_valid CHECK (overall IN ('good', 'average', 'redflag'))
);
CREATE INDEX exam_results_enrollment_idx ON exam_results (enrollment_id, date);

CREATE TABLE exam_result_units (
  result_id bigint NOT NULL REFERENCES exam_results (id) ON DELETE CASCADE,
  unit_id   text   NOT NULL,
  scores    jsonb  NOT NULL,
  PRIMARY KEY (result_id, unit_id)
);
