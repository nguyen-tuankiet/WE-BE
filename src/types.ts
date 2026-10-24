import type { AppConfig } from './config.js';
import type { Role } from './domain/roles.js';
import type { Db } from './db/types.js';

export interface Deps {
  db: Db;
  config: AppConfig;
  /** Ngày hiện tại (giờ Việt Nam, `YYYY-MM-DD`); tách ra để test cố định được ngày. */
  today: () => string;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  sessionId: string;
}

export type AppEnv = {
  Variables: { user: AuthUser };
};
