-- 0002: danh mục (gói, ca, phòng, cài đặt), ngày nghỉ, học viên, lớp, khóa đăng ký và lịch buổi học.
-- Ngày nghiệp vụ dùng kiểu date; tiền là bigint (VNĐ). Chỉ SQL PostgreSQL chuẩn.

CREATE TABLE slots (
  id          text PRIMARY KEY,
  label       text NOT NULL,
  time_range  text NOT NULL,
  sort_order  int  NOT NULL
);

CREATE TABLE rooms (
  id          text PRIMARY KEY,
  floor       text NOT NULL,
  sort_order  int  NOT NULL
);

CREATE TABLE settings (
  key         text PRIMARY KEY,
  value       jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE programs (
  id             text PRIMARY KEY,
  grp            text    NOT NULL,
  name           text    NOT NULL,
  tuition        bigint  NOT NULL,
  sessions_count int,
  max_size       int     NOT NULL,
  unit_template  text,
  note           text,
  active         boolean NOT NULL DEFAULT true,
  sort_order     int     NOT NULL DEFAULT 0,
  CONSTRAINT programs_grp_valid CHECK (grp IN ('baby', 'foundation', 'cambridge', 'ket', 'pet', 'ielts', 'communication', 'grade10')),
  CONSTRAINT programs_tuition_valid CHECK (tuition >= 0),
  CONSTRAINT programs_sessions_valid CHECK (sessions_count IS NULL OR sessions_count > 0),
  CONSTRAINT programs_max_size_valid CHECK (max_size > 0),
  CONSTRAINT programs_template_valid CHECK (unit_template IS NULL OR unit_template IN ('baby', 'foundation', 'cambridge'))
);

-- Ngày trung tâm nghỉ (toàn trung tâm). Thêm/xóa ngày nghỉ làm dời lịch buổi chính của các khóa.
CREATE TABLE holidays (
  date        date PRIMARY KEY,
  reason      text        NOT NULL,
  created_by  bigint REFERENCES users (id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE student_code_seq START 1;

CREATE TABLE students (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          text        NOT NULL,
  name          text        NOT NULL,
  birthday      date        NOT NULL,
  status        text        NOT NULL DEFAULT 'active',
  guardian      text        NOT NULL DEFAULT '',
  phone         text        NOT NULL DEFAULT '',
  address       text        NOT NULL DEFAULT '',
  tuition_mode  text        NOT NULL DEFAULT '',
  note          text        NOT NULL DEFAULT '',
  next_course   text        NOT NULL DEFAULT '',
  star          boolean     NOT NULL DEFAULT false,
  redflag_below int,
  good_above    int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT students_code_unique UNIQUE (code),
  CONSTRAINT students_status_valid CHECK (status IN ('active', 'reserved', 'left')),
  CONSTRAINT students_star_thresholds CHECK (
    NOT star OR (redflag_below IS NOT NULL AND good_above IS NOT NULL AND redflag_below >= 0 AND good_above <= 100 AND redflag_below < good_above)
  )
);
CREATE INDEX students_name_idx ON students (name);

CREATE TABLE classes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        text    NOT NULL,
  subject     text    NOT NULL DEFAULT '',
  slot_id     text    NOT NULL REFERENCES slots (id),
  room        text    NOT NULL REFERENCES rooms (id),
  teacher_id  bigint  REFERENCES users (id) ON DELETE SET NULL,
  assistant   text    NOT NULL DEFAULT '',
  max_size    int     NOT NULL DEFAULT 10,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT classes_max_size_valid CHECK (max_size > 0)
);
CREATE INDEX classes_teacher_idx ON classes (teacher_id);

CREATE TABLE class_weekdays (
  class_id bigint   NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  weekday  smallint NOT NULL,
  PRIMARY KEY (class_id, weekday),
  CONSTRAINT class_weekdays_valid CHECK (weekday BETWEEN 0 AND 6)
);

-- Khóa đăng ký: quyền học cụ thể của một học viên. Học phí và định mức bù được CHỤP tại thời điểm đăng ký,
-- nên sửa danh mục sau đó không ghi đè khóa đã có.
CREATE TABLE enrollments (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  student_id       bigint  NOT NULL REFERENCES students (id),
  program_id       text    NOT NULL REFERENCES programs (id),
  class_id         bigint  NOT NULL REFERENCES classes (id),
  start_date       date    NOT NULL,
  total_sessions   int     NOT NULL,
  tuition          bigint  NOT NULL,
  tuition_received boolean NOT NULL DEFAULT false,
  makeup_max       int,
  makeup_minutes   int,
  status           text    NOT NULL DEFAULT 'active',
  note             text    NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enrollments_total_valid CHECK (total_sessions > 0),
  CONSTRAINT enrollments_tuition_valid CHECK (tuition >= 0),
  CONSTRAINT enrollments_status_valid CHECK (status IN ('active', 'reserved', 'completed'))
);
CREATE INDEX enrollments_student_idx ON enrollments (student_id);
CREATE INDEX enrollments_class_idx ON enrollments (class_id);

-- Lịch học theo giai đoạn (có ngày hiệu lực). Bản đầu mỗi khóa có một giai đoạn; chuyển lớp (M3) sẽ thêm giai đoạn mới.
CREATE TABLE enrollment_schedule (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id  bigint     NOT NULL REFERENCES enrollments (id) ON DELETE CASCADE,
  effective_from date       NOT NULL,
  class_id       bigint     NOT NULL REFERENCES classes (id),
  weekdays       smallint[] NOT NULL,
  CONSTRAINT enrollment_schedule_weekdays_valid CHECK (cardinality(weekdays) > 0),
  CONSTRAINT enrollment_schedule_unique UNIQUE (enrollment_id, effective_from)
);

-- Các buổi chính đã sinh sẵn của từng khóa. Buổi vắng vẫn nằm trong định mức; học bù theo dõi riêng (M3).
CREATE TABLE course_sessions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  enrollment_id  bigint NOT NULL REFERENCES enrollments (id) ON DELETE CASCADE,
  seq            int    NOT NULL,
  date           date   NOT NULL,
  class_id       bigint NOT NULL REFERENCES classes (id),
  CONSTRAINT course_sessions_seq_unique UNIQUE (enrollment_id, seq),
  CONSTRAINT course_sessions_date_unique UNIQUE (enrollment_id, date)
);
CREATE INDEX course_sessions_date_idx ON course_sessions (date);
