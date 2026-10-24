-- 0003: điểm danh buổi chính.
-- Một khóa + một ngày chỉ có MỘT kết quả (UNIQUE). Chỉ ghi được vào ngày có trong lịch khóa (khóa ngoại tới course_sessions).
-- Thiếu bản ghi = "Chưa ghi nhận" (không suy đoán có mặt/vắng).

CREATE TABLE attendance (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id  bigint      NOT NULL,
  date           date        NOT NULL,
  class_id       bigint      NOT NULL REFERENCES classes (id),
  status         text        NOT NULL,
  notified       boolean     NOT NULL DEFAULT false,
  note           text        NOT NULL DEFAULT '',
  recorded_by    bigint REFERENCES users (id) ON DELETE SET NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  updated_by     bigint REFERENCES users (id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT attendance_unique UNIQUE (enrollment_id, date),
  CONSTRAINT attendance_status_valid CHECK (status IN ('present', 'late', 'absent')),
  -- "Đã báo nghỉ" chỉ có nghĩa với buổi Vắng (docs/02: chỉ một loại Vắng, báo nghỉ là thuộc tính kèm theo).
  CONSTRAINT attendance_notified_only_absent CHECK (NOT notified OR status = 'absent'),
  CONSTRAINT attendance_in_schedule FOREIGN KEY (enrollment_id, date) REFERENCES course_sessions (enrollment_id, date)
);
CREATE INDEX attendance_date_idx ON attendance (date);
CREATE INDEX attendance_class_date_idx ON attendance (class_id, date);
