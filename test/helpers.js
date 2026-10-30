// Test helpers: start a real server on a random port with its own temporary database.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { newKey } from '../server/crypto.js';

export const SEED_PASSWORD = 'Review-2026-ksa';
export const seedEmail = (role) => `${role}@sahara.example`;

export async function startApp(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wazin-test-'));
  const dbFile = path.join(dir, 'test.db');
  const app = createApp({ env: { WAZIN_DATA_KEY: newKey(), WAZIN_DB: dbFile, WAZIN_SEED_PASSWORD: SEED_PASSWORD, ...env }, llm: null, log: () => {} });
  await app.ready;
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    app, base, dbFile,
    client: () => client(base),
    stop: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A browser-like client: keeps its session cookie and CSRF token. */
export function client(base) {
  const c = { cookie: '', csrf: '', lastSetCookie: '' };
  c.call = async (method, p, body, { headers = {}, raw } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(c.cookie ? { cookie: c.cookie } : {}), ...(c.csrf ? { 'x-csrf-token': c.csrf } : {}), ...headers },
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) { c.lastSetCookie = sc; c.cookie = sc.split(';')[0]; }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (json && json.csrf) c.csrf = json.csrf;
    return { status: res.status, body: json, headers: res.headers };
  };
  // Sign in to the seeded company as one of its teams.
  c.as = async (role) => { if (c.cookie) await c.call('POST', '/api/logout', {}); c.cookie = ''; c.csrf = ''; return c.call('POST', '/api/login', { email: seedEmail(role), password: SEED_PASSWORD }); };
  c.company = async () => c.as('ap');
  return c;
}
