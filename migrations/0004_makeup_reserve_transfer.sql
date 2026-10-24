-- 0004: học bù, bảo lưu học phí, chuyển lớp.

-- Học bù: mỗi lượt gắn với MỘT buổi vắng đã báo nghỉ (khóa ngoại tới bản ghi điểm danh).
-- Một buổi vắng chỉ có tối đa một lượt bù hiệu lực (chỉ mục duy nhất một phần, bỏ qua lượt Đã hủy).
-- Hoàn tất (done) và Vắng bù (missed) là hai trạng thái khác nhau: Vắng bù vẫn tính đã dùng lượt.
CREATE TABLE makeups (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id    bigint      NOT NULL REFERENCES enrollments (id),
  absence_date     date        NOT NULL,
  date             date        NOT NULL,
  minutes          int         NOT NULL,
  room             text        NOT NULL REFERENCES rooms (id),
  status           text        NOT NULL DEFAULT 'scheduled',
  notified_parent  boolean     NOT NULL DEFAULT false,
  note             text        NOT NULL DEFAULT '',
  created_by       bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       bigint REFERENCES users (id) ON DELETE SET NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT makeups_minutes_valid CHECK (minutes > 0),
  CONSTRAINT makeups_status_valid CHECK (status IN ('scheduled', 'done', 'missed', 'cancelled')),
  CONSTRAINT makeups_after_absence CHECK (date > absence_date),
  CONSTRAINT makeups_absence_fk FOREIGN KEY (enrollment_id, absence_date) REFERENCES attendance (enrollment_id, date)
);
CREATE UNIQUE INDEX makeups_one_active_per_absence ON makeups (enrollment_id, absence_date) WHERE status <> 'cancelled';
-- Hai lượt bù hiệu lực của cùng một khóa không trùng ngày (buổi 30 phút mỗi buổi chính chỉ gắn một lượt).
CREATE UNIQUE INDEX makeups_one_active_per_day ON makeups (enrollment_id, date) WHERE status <> 'cancelled';
CREATE INDEX makeups_date_idx ON makeups (date);

-- Bảo lưu: tối đa MỘT lần cho một khóa (UNIQUE). Chỉ bảo lưu học phí phần chưa diễn ra; không hoàn tiền.
CREATE TABLE reserves (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id       bigint      NOT NULL REFERENCES enrollments (id),
  notice_at           timestamptz NOT NULL,
  completed_on        date        NOT NULL,
  expires_on          date        NOT NULL,
  absent_streak       int         NOT NULL,
  remaining_sessions  int         NOT NULL,
  amount              bigint      NOT NULL,
  status              text        NOT NULL DEFAULT 'active',
  returned_on         date,
  return_class_id     bigint REFERENCES classes (id),
  note                text        NOT NULL DEFAULT '',
  created_by          bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reserves_one_per_enrollment UNIQUE (enrollment_id),
  CONSTRAINT reserves_status_valid CHECK (status IN ('active', 'returned', 'expired')),
  CONSTRAINT reserves_streak_valid CHECK (absent_streak >= 10),
  CONSTRAINT reserves_amount_valid CHECK (amount >= 0),
  CONSTRAINT reserves_expiry_valid CHECK (expires_on > completed_on)
);
CREATE INDEX reserves_status_idx ON reserves (status, expires_on);

-- Chuyển lớp giữa khóa: giữ quyền học còn lại, lưu lớp đi/đến, ngày hiệu lực và số buổi còn lại tại thời điểm chuyển.
CREATE TABLE transfers (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id       bigint NOT NULL REFERENCES enrollments (id),
  from_class_id       bigint NOT NULL REFERENCES classes (id),
  to_class_id         bigint NOT NULL REFERENCES classes (id),
  effective_date      date   NOT NULL,
  remaining_sessions  int    NOT NULL,
  note                text   NOT NULL DEFAULT '',
  created_by          bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transfers_different_class CHECK (from_class_id <> to_class_id)
);
CREATE INDEX transfers_enrollment_idx ON transfers (enrollment_id);
