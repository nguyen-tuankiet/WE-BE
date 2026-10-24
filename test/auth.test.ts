import { describe, expect, it } from 'vitest';
import { BOOTSTRAP_SECRET, Client, bootstrapAdmin, createTestApp } from './helpers.js';

describe('khởi tạo Admin đầu tiên', () => {
  it('sai mã → 403, đúng mã → 201, gọi lại → 409', async () => {
    const { app } = await createTestApp();
    const c = new Client(app);
    const body = { email: 'admin@we.vn', name: 'Quản trị', pin: '123456' };

    const bad = await c.post('/api/v1/auth/bootstrap', { ...body, secret: 'sai-ma-khoi-tao-123' });
    expect(bad.status).toBe(403);

    const ok = await c.post('/api/v1/auth/bootstrap', { ...body, secret: BOOTSTRAP_SECRET });
    expect(ok.status).toBe(201);
    expect(ok.body.user.roles).toEqual(['admin']);

    const again = await c.post('/api/v1/auth/bootstrap', { ...body, email: 'khac@we.vn', secret: BOOTSTRAP_SECRET });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_BOOTSTRAPPED');
  });

  it('không cấu hình BOOTSTRAP_SECRET thì đường dẫn không tồn tại (404)', async () => {
    const { app } = await createTestApp({ bootstrapSecret: undefined });
    const res = await new Client(app).post('/api/v1/auth/bootstrap', { secret: 'x', email: 'a@we.vn', name: 'A', pin: '123456' });
    expect(res.status).toBe(404);
  });
});

describe('đăng nhập và phiên', () => {
  it('kiểm tra dữ liệu: PIN sai định dạng → 400 kèm lỗi theo trường', async () => {
    const { app } = await createTestApp();
    const res = await new Client(app).post('/api/v1/auth/login', { email: 'khong-phai-email', pin: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
    expect(Object.keys(res.body.error.fields).sort()).toEqual(['email', 'pin']);
  });

  it('sai PIN và email không tồn tại cùng trả 401 INVALID_CREDENTIALS', async () => {
    const { app } = await createTestApp();
    await bootstrapAdmin(app);
    const c = new Client(app);
    const wrongPin = await c.post('/api/v1/auth/login', { email: 'admin@we.vn', pin: '000000' });
    const noUser = await c.post('/api/v1/auth/login', { email: 'khong-co@we.vn', pin: '123456' });
    expect(wrongPin.status).toBe(401);
    expect(noUser.status).toBe(401);
    expect(wrongPin.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(noUser.body.error).toEqual(wrongPin.body.error);
  });

  it('đăng nhập đúng → cookie HttpOnly, /me trả vai trò; chưa đăng nhập → 401', async () => {
    const { app } = await createTestApp();
    const c = await bootstrapAdmin(app);
    const me = await c.get('/api/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ email: 'admin@we.vn', roles: ['admin'] });
    expect(me.body.user.sessionId).toBeUndefined();

    const anonymous = await new Client(app).get('/api/v1/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe('UNAUTHENTICATED');

    const login = await new Client(app).post('/api/v1/auth/login', { email: 'ADMIN@we.vn', pin: '123456' });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toMatch(/HttpOnly/i);
  });

  it('giới hạn thử đăng nhập: sai quá 5 lần → 429, kể cả khi nhập đúng PIN sau đó', async () => {
    const { app } = await createTestApp();
    await bootstrapAdmin(app);
    const c = new Client(app);
    for (let i = 0; i < 5; i++) {
      const r = await c.post('/api/v1/auth/login', { email: 'admin@we.vn', pin: '111111' });
      expect(r.status).toBe(401);
    }
    const blocked = await c.post('/api/v1/auth/login', { email: 'admin@we.vn', pin: '123456' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_ATTEMPTS');
  });

  it('đăng xuất thu hồi phiên: dùng lại cookie cũ → 401', async () => {
    const { app } = await createTestApp();
    const c = await bootstrapAdmin(app);
    const oldCookie = c.cookie;
    expect((await c.post('/api/v1/auth/logout')).status).toBe(200);

    const replay = new Client(app);
    replay.cookie = oldCookie;
    expect((await replay.get('/api/v1/me')).status).toBe(401);
  });
});

describe('quản lý nhân sự và phân quyền (NT15, NT16)', () => {
  async function setup() {
    const ctx = await createTestApp();
    const admin = await bootstrapAdmin(ctx.app);
    const created = await admin.post('/api/v1/staff', { email: 'gv@we.vn', name: 'Giáo viên A', pin: '654321', roles: ['teacher'] });
    expect(created.status).toBe(201);
    const teacher = new Client(ctx.app);
    expect((await teacher.post('/api/v1/auth/login', { email: 'gv@we.vn', pin: '654321' })).status).toBe(200);
    return { ...ctx, admin, teacher, teacherId: created.body.staff.id as string };
  }

  it('giáo viên bị từ chối ở server khi gọi API quản lý nhân sự', async () => {
    const { teacher } = await setup();
    const res = await teacher.get('/api/v1/staff');
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect((await teacher.post('/api/v1/staff', { email: 'x@we.vn', name: 'X', pin: '123456', roles: ['admin'] })).status).toBe(403);
  });

  it('Admin tạo nhân sự: email trùng → 409, vai trò sai → 400, danh sách có đủ', async () => {
    const { admin } = await setup();
    const dup = await admin.post('/api/v1/staff', { email: 'GV@we.vn', name: 'Trùng', pin: '123456', roles: ['teacher'] });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_EXISTS');

    const badRole = await admin.post('/api/v1/staff', { email: 'b@we.vn', name: 'B', pin: '123456', roles: ['hacker'] });
    expect(badRole.status).toBe(400);

    const list = await admin.get('/api/v1/staff');
    expect(list.body.staff.map((s: { email: string }) => s.email).sort()).toEqual(['admin@we.vn', 'gv@we.vn']);
  });

  it('khóa tài khoản: phiên đang có bị thu hồi ngay, đăng nhập lại → 403, lịch sử thao tác được ghi', async () => {
    const { admin, teacher, teacherId, db } = await setup();
    expect((await teacher.get('/api/v1/me')).status).toBe(200);

    const locked = await admin.patch(`/api/v1/staff/${teacherId}`, { active: false });
    expect(locked.status).toBe(200);
    expect(locked.body.staff.active).toBe(false);

    expect((await teacher.get('/api/v1/me')).status).toBe(401);

    const log = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE entity = 'user' AND action = 'update'");
    expect(log.rows[0].n).toBe(1);
  });

  it('đổi PIN thu hồi phiên cũ; PIN cũ không còn dùng được', async () => {
    const { admin, teacher, teacherId, app } = await setup();
    expect((await admin.patch(`/api/v1/staff/${teacherId}`, { pin: '999999' })).status).toBe(200);
    expect((await teacher.get('/api/v1/me')).status).toBe(401);

    const c = new Client(app);
    expect((await c.post('/api/v1/auth/login', { email: 'gv@we.vn', pin: '654321' })).status).toBe(401);
    expect((await c.post('/api/v1/auth/login', { email: 'gv@we.vn', pin: '999999' })).status).toBe(200);
  });

  it('tài khoản bị khóa không đăng nhập được dù đúng PIN (403 ACCOUNT_DISABLED)', async () => {
    const { admin, teacherId, app } = await setup();
    await admin.patch(`/api/v1/staff/${teacherId}`, { active: false });
    const res = await new Client(app).post('/api/v1/auth/login', { email: 'gv@we.vn', pin: '654321' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  it('Admin không thể tự khóa mình hoặc tự bỏ quyền Admin', async () => {
    const { admin } = await setup();
    const me = (await admin.get('/api/v1/me')).body.user;
    const lock = await admin.patch(`/api/v1/staff/${me.id}`, { active: false });
    expect(lock.status).toBe(422);
    expect(lock.body.error.code).toBe('CANNOT_LOCK_SELF');
    expect((await admin.patch(`/api/v1/staff/${me.id}`, { roles: ['teacher'] })).status).toBe(422);
  });
});

describe('chặn nguồn lạ', () => {
  it('có cấu hình CORS_ORIGIN: yêu cầu ghi từ Origin lạ → 403, Origin hợp lệ → qua', async () => {
    const { app } = await createTestApp({ corsOrigins: ['https://we-fe.example.com'] });
    const c = new Client(app);
    const body = { email: 'x@we.vn', pin: '123456' };
    const bad = await c.post('/api/v1/auth/login', body, { origin: 'https://evil.example.com' });
    expect(bad.status).toBe(403);
    expect(bad.body.error.code).toBe('BAD_ORIGIN');
    const ok = await c.post('/api/v1/auth/login', body, { origin: 'https://we-fe.example.com' });
    expect(ok.status).toBe(401);
  });
});

describe('sức khỏe hệ thống', () => {
  it('GET /health trả ok khi DB sẵn sàng', async () => {
    const { app } = await createTestApp();
    const res = await new Client(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, today: '2026-10-22' });
  });
});
