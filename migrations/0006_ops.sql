-- 0006: vận hành — nhắc việc đã xử lý, lịch điều phối CAP.

-- Công việc nhắc (sinh động từ dữ liệu); chỉ lưu việc đã đánh dấu "đã xử lý": ai và khi nào.
CREATE TABLE tasks_handled (
  key         text PRIMARY KEY,
  handled_by  bigint REFERENCES users (id) ON DELETE SET NULL,
  handled_by_name text NOT NULL,
  handled_at  timestamptz NOT NULL DEFAULT now()
);

-- Lịch CAP: nhóm ngày × ca × phòng → một lớp thật. Một phòng trong một ca của một nhóm ngày chỉ có một lớp;
-- một lớp chỉ xuất hiện một lần trong cùng nhóm ngày + ca.
CREATE TABLE class_cap (
  class_id   bigint NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  cap_group  text   NOT NULL,
  slot_id    text   NOT NULL REFERENCES slots (id),
  room       text   NOT NULL REFERENCES rooms (id),
  created_by bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cap_group, slot_id, room),
  CONSTRAINT class_cap_one_per_slot UNIQUE (class_id, cap_group, slot_id),
  CONSTRAINT class_cap_group_valid CHECK (cap_group IN ('2-4-6', '3-5', '7'))
);
