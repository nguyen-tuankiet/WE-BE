import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPgDb } from './db/pg.js';
import { todayVN } from './domain/dates.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const db = createPgDb(config.databaseUrl);
const app = createApp({ db, config: config.app, today: todayVN });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`WE backend đang chạy tại http://localhost:${info.port}`);
});

async function shutdown() {
  server.close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
