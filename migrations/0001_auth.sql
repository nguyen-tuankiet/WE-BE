-- 0001: tài khoản, vai trò, phiên đăng nhập, giới hạn thử đăng nhập, nhật ký thao tác.
-- Chỉ SQL PostgreSQL chuẩn (xem docs/10). Migration chỉ THÊM, không sửa lại file đã chạy.

CREATE TABLE users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text        NOT NULL,
  name        text        NOT NULL,
  pin_hash    text        NOT NULL,
  active      boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);

CREATE TABLE user_roles (
  user_id bigint NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role    text   NOT NULL,
  PRIMARY KEY (user_id, role),
  CONSTRAINT user_roles_role_valid CHECK (role IN ('admin', 'manager', 'teacher', 'inspector'))
);

CREATE TABLE auth_sessions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  user_agent  text,
  CONSTRAINT auth_sessions_token_unique UNIQUE (token_hash)
);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id);

CREATE TABLE login_attempts (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email    text        NOT NULL,
  success  boolean     NOT NULL,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_attempts_email_at_idx ON login_attempts (email, at);

CREATE TABLE audit_log (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  user_id    bigint,
  entity     text        NOT NULL,
  entity_id  text        NOT NULL,
  action     text        NOT NULL,
  detail     jsonb
);
CREATE INDEX audit_log_entity_idx ON audit_log (entity, entity_id);
CREATE INDEX audit_log_at_idx ON audit_log (at);
