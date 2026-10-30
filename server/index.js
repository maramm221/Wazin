// Entry point: node server/index.js
import fs from 'node:fs';
import path from 'node:path';
import { createApp, makeLogger } from './app.js';
import { newKey } from './crypto.js';

const log = makeLogger(process.env.LOG_LEVEL || 'info');
const production = process.env.NODE_ENV === 'production';

// Encryption key. In production it must come from the environment (a secret in your host).
// For local development a key is generated once and kept in var/dev.key (git-ignored).
if (!process.env.WAZIN_DATA_KEY) {
  if (production) {
    log('error', 'WAZIN_DATA_KEY is required in production. Generate one with: npm run keygen');
    process.exit(1);
  }
  const f = path.resolve('var/dev.key');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) fs.writeFileSync(f, newKey(), { mode: 0o600 });
  process.env.WAZIN_DATA_KEY = fs.readFileSync(f, 'utf8').trim();
  log('warn', 'Using a development encryption key from var/dev.key. Set WAZIN_DATA_KEY in production.');
}

const app = createApp({ log });
const port = Number(process.env.PORT || 3000);
app.ready.then(() => app.server.listen(port, () => log('info', 'listening', { url: `http://localhost:${port}`, ai: !!app.service.llm, env: production ? 'production' : 'development' })));

let closing = false;
const shutdown = (sig) => {
  if (closing) return;
  closing = true;
  log('info', 'shutting_down', { signal: sig });
  app.close().then(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log('error', 'unhandled_rejection', { err: String(e?.message || e) }));
