import { Hono } from 'hono';
import { z } from 'zod';
import { isIsoDate } from '../domain/dates.js';
import { errors } from '../errors.js';
import { idSchema } from '../lib/schemas.js';
import { parseBody } from '../lib/validate.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { listResultsByRating } from '../services/academics.js';
import { addCapSlot, getCap, removeCapSlot } from '../services/cap.js';
import { attendanceDetail, endingDetail, getCharts, getDashboard, groupDetail, listTasks, markTask } from '../services/dashboard.js';
import { csvToRows, exportStudentsCsv, importStudents, type ImportRow } from '../services/dataio.js';
import type { AppEnv, Deps } from '../types.js';

const capBody = z.object({ classId: idSchema, group: z.string().min(1), slotId: z.string().min(1), room: z.string().min(1) });
const taskBody = z.object({ done: z.boolean() });
const importBody = z.object({
  dryRun: z.boolean().default(false),
  csv: z.string().max(2_000_000).optional(),
  rows: z
    .array(
      z.object({
        name: z.string().optional(),
        birthday: z.string().optional(),
        guardian: z.string().optional(),
        phone: z.string().optional(),
        address: z.string().optional(),
        tuitionMode: z.string().optional(),
        note: z.string().optional(),
      }),
    )
    .max(2000)
    .optional(),
});

function range(from: string | undefined, to: string | undefined, today: string) {
  const f = from ?? to ?? today;
  const t = to ?? f;
  if (!isIsoDate(f) || !isIsoDate(t)) throw errors.validation({ from: 'Ngày không hợp lệ (YYYY-MM-DD).' });
  return { from: f, to: t };
}

/** Tổng quan, nhắc việc, lịch CAP, nhập/xuất dữ liệu. Phân quyền chi tiết nằm ở từng thao tác (docs/01). */
export function opsRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const { db } = deps;
  app.use('*', requireAuth(deps));
  const manage = requireRole('admin', 'manager');

  /* ----- Tổng quan ----- */
  app.get('/dashboard', async (c) => {
    const { from, to } = range(c.req.query('from'), c.req.query('to'), deps.today());
    return c.json(await getDashboard(db, c.get('user'), from, to, deps.today()));
  });
  app.get('/dashboard/charts', async (c) => {
    const { from, to } = range(c.req.query('from'), c.req.query('to'), deps.today());
    return c.json(await getCharts(db, c.get('user'), from, to));
  });
  app.get('/dashboard/detail/attendance', manage, async (c) => {
    const date = c.req.query('date') ?? '';
    const status = c.req.query('status');
    if (!isIsoDate(date) || (status !== 'present' && status !== 'late' && status !== 'absent')) throw errors.validation({ date: 'Cần ngày và trạng thái hợp lệ.' });
    return c.json({ rows: await attendanceDetail(db, date, status) });
  });
  app.get('/dashboard/detail/group', manage, async (c) => c.json({ enrollments: await groupDetail(db, deps.today(), c.req.query('group') ?? '') }));
  app.get('/dashboard/detail/ending', manage, async (c) => {
    const { from, to } = range(c.req.query('from'), c.req.query('to'), deps.today());
    return c.json({ enrollments: await endingDetail(db, deps.today(), from, to) });
  });
  app.get('/dashboard/detail/rating', requireRole('admin', 'manager', 'inspector'), async (c) => {
    const rating = c.req.query('rating');
    if (rating !== 'good' && rating !== 'average' && rating !== 'redflag') throw errors.validation({ rating: 'Phân loại không hợp lệ.' });
    return c.json({ results: await listResultsByRating(db, rating) });
  });

  /* ----- Việc cần quan tâm ----- */
  app.get('/tasks', async (c) => c.json({ tasks: await listTasks(db, c.get('user'), deps.today()) }));
  app.put('/tasks/:key', async (c) => {
    const body = await parseBody(c, taskBody);
    await markTask(db, c.get('user'), c.req.param('key'), body.done);
    return c.json({ ok: true });
  });

  /* ----- Lịch CAP ----- */
  app.get('/cap', manage, async (c) => c.json(await getCap(db, c.req.query('group') ?? '')));
  app.post('/cap', manage, async (c) => {
    const body = await parseBody(c, capBody);
    await addCapSlot(db, c.get('user'), body);
    return c.json({ ok: true }, 201);
  });
  app.delete('/cap', manage, async (c) => {
    const group = c.req.query('group') ?? '';
    const slotId = c.req.query('slotId') ?? '';
    const room = c.req.query('room') ?? '';
    if (!group || !slotId || !room) throw errors.validation({ group: 'Thiếu nhóm ngày, ca hoặc phòng.' });
    await removeCapSlot(db, c.get('user'), { group, slotId, room });
    return c.json({ ok: true });
  });

  /* ----- Nhập / xuất ----- */
  app.get('/export/students.csv', manage, async (c) => {
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="hoc-vien.csv"');
    return c.body(await exportStudentsCsv(db));
  });
  app.post('/import/students', manage, async (c) => {
    const body = await parseBody(c, importBody);
    if (!body.csv && !body.rows) throw errors.validation({ rows: 'Cần gửi `rows` hoặc `csv`.' });
    const rows: ImportRow[] = body.rows ?? csvToRows(body.csv ?? '');
    return c.json(await importStudents(db, c.get('user'), rows, deps.today(), body.dryRun));
  });

  return app;
}

