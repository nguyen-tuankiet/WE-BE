import { createApp } from '../src/app.js';
import { DEFAULT_APP_CONFIG, type AppConfig } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';
import { createPgliteDb } from '../src/db/pglite.js';
import { seedReference } from '../src/seed/reference.js';

export const BOOTSTRAP_SECRET = 'test-bootstrap-secret-123';
export const TEST_TODAY = '2026-10-22';

export async function createTestApp(overrides: Partial<AppConfig> = {}) {
  const db = await createPgliteDb();
  await runMigrations(db);
  const config: AppConfig = { ...DEFAULT_APP_CONFIG, bootstrapSecret: BOOTSTRAP_SECRET, ...overrides };
  await seedReference(db);
  const app = createApp({ db, config, today: () => TEST_TODAY });
  return { app, db, config };
}

type App = ReturnType<typeof createApp>;

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

/** Máy khách thử nghiệm giữ cookie phiên như một trình duyệt. */
export class Client {
  cookie = '';
  constructor(private readonly app: App) {}

  async req(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<ApiResponse> {
    const headers: Record<string, string> = { ...extraHeaders };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await this.app.request(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    const m = set ? /we_session=([^;]*)/.exec(set) : null;
    if (m) this.cookie = m[1] ? `we_session=${m[1]}` : '';
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }

  get = (path: string) => this.req('GET', path);
  post = (path: string, body?: unknown, headers?: Record<string, string>) => this.req('POST', path, body ?? {}, headers);
  patch = (path: string, body: unknown) => this.req('PATCH', path, body);
}

export async function bootstrapAdmin(app: App, email = 'admin@we.vn', pin = '123456') {
  const c = new Client(app);
  const res = await c.post('/api/v1/auth/bootstrap', { secret: BOOTSTRAP_SECRET, email, name: 'Quản trị', pin });
  if (res.status !== 201) throw new Error(`bootstrap thất bại: ${res.status} ${JSON.stringify(res.body)}`);
  const login = await c.post('/api/v1/auth/login', { email, pin });
  if (login.status !== 200) throw new Error(`đăng nhập thất bại: ${login.status}`);
  return c;
}
