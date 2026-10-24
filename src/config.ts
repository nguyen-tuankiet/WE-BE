import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1, 'Thiếu DATABASE_URL'),
  BOOTSTRAP_SECRET: z.string().min(16, 'BOOTSTRAP_SECRET cần ít nhất 16 ký tự').optional().or(z.literal('')),
  CORS_ORIGIN: z.string().default(''),
  COOKIE_SAMESITE: z.enum(['Lax', 'None', 'Strict']).default('Lax'),
  SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
  LOGIN_MAX_FAILS: z.coerce.number().int().min(1).default(5),
  LOGIN_WINDOW_MINUTES: z.coerce.number().int().min(1).default(15),
});

export interface AppConfig {
  isProd: boolean;
  bootstrapSecret?: string;
  corsOrigins: string[];
  sameSite: 'Lax' | 'None' | 'Strict';
  sessionDays: number;
  loginMaxFails: number;
  loginWindowMinutes: number;
}

export interface ServerConfig {
  port: number;
  databaseUrl: string;
  app: AppConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Cấu hình môi trường chưa hợp lệ: ${msg}`);
  }
  const e = parsed.data;
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    app: {
      isProd: e.NODE_ENV === 'production',
      bootstrapSecret: e.BOOTSTRAP_SECRET || undefined,
      corsOrigins: e.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean),
      sameSite: e.COOKIE_SAMESITE,
      sessionDays: e.SESSION_DAYS,
      loginMaxFails: e.LOGIN_MAX_FAILS,
      loginWindowMinutes: e.LOGIN_WINDOW_MINUTES,
    },
  };
}

export const DEFAULT_APP_CONFIG: AppConfig = {
  isProd: false,
  corsOrigins: [],
  sameSite: 'Lax',
  sessionDays: 30,
  loginMaxFails: 5,
  loginWindowMinutes: 15,
};
