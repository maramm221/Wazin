// HTTP layer: routing, sessions, CSRF, rate limits, security headers, static files, logging.
// Built on node:http only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { Store } from './store.js';
import { Service, AppError } from './service.js';
import { loadKey, randomToken, safeEqual } from './crypto.js';
import { anthropicLLM } from '../src/llm.js';
import { csvCell } from './csv.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const MAX_BODY = 1024 * 1024;
const COOKIE = 'wz_session';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.csv': 'text/csv; charset=utf-8', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

// ---------- logging (JSON lines; never bodies, cookies or secrets) ----------
/** Structured JSON-lines logger. Never given request bodies, cookies, passwords or bank details. */
export function makeLogger(level = process.env.LOG_LEVEL || 'info', out = process.stdout) {
  const order = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  return (lvl, msg, fields = {}) => {
    if (order[lvl] < order[level]) return;
    out.write(`${JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields })}\n`);
  };
}

// ---------- rate limiting (fixed window, per key) ----------
class RateLimiter {
  constructor() { this.m = new Map(); }
  hit(key, limit, windowMs) {
    const t = Date.now();
    let e = this.m.get(key);
    if (!e || e.reset < t) { e = { n: 0, reset: t + windowMs }; this.m.set(key, e); }
    e.n++;
    if (this.m.size > 50000) for (const [k, v] of this.m) if (v.reset < t) this.m.delete(k);
    return e.n <= limit ? null : Math.ceil((e.reset - t) / 1000);
  }
}

function parseCookies(h = '') {
  const out = {};
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Build the HTTP server: routes, sessions, CSRF, rate limits, security headers and static files.
 * Returns { server, store, service, log, ready, close }. Settings come from opts.env (see docs/DEPLOY.md).
 */
export function createApp(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const production = env.NODE_ENV === 'production';
  const log = opts.log || makeLogger(env.LOG_LEVEL || (production ? 'info' : 'info'));
  const key = loadKey(env.WAZIN_DATA_KEY);
  const db = openDb(env.WAZIN_DB || path.join(ROOT, 'var', 'wazin.db'));
  const store = new Store(db, key);
  const llm = opts.llm !== undefined ? opts.llm : anthropicLLM({ apiKey: env.ANTHROPIC_API_KEY, model: env.WAZIN_MODEL || undefined });
  const service = new Service(store, { llm, log });
  const limiter = new RateLimiter();
  const secureCookies = env.WAZIN_SECURE_COOKIES ? env.WAZIN_SECURE_COOKIES === '1' : production;
  const trustProxy = env.WAZIN_TRUST_PROXY === '1' || production;
  const allowSignup = env.WAZIN_ALLOW_SIGNUP !== '0';

  const ip = (req) => (trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';

  function headers(res, extra = {}) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
  function send(res, status, body, extra = {}) {
    headers(res, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.writeHead(status);
    res.end(body === undefined ? '' : JSON.stringify(body));
  }
  function setSession(res, token) {
    const attrs = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${12 * 3600}`];
    if (secureCookies) attrs.push('Secure');
    res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(token)}; ${attrs.join('; ')}`);
  }
  function clearSession(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookies ? '; Secure' : ''}`);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const ct = String(req.headers['content-type'] || '');
      if (!ct.startsWith('application/json')) return reject(new AppError(415, 'json_required'));
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          if (!req.__tooLarge) { req.__tooLarge = true; reject(new AppError(413, 'body_too_large')); }
          return; // keep draining up to the socket timeout instead of buffering; response closes the connection
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!size) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error();
          resolve(v);
        } catch { reject(new AppError(400, 'invalid_json')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? '/index.html' : pathname;
    if (rel.includes('\0')) return false;
    let file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return false;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      if (path.extname(rel)) return false;
      file = path.join(PUBLIC, 'index.html'); // client-side routes
    }
    const type = TYPES[path.extname(file)] || 'application/octet-stream';
    const html = file.endsWith('.html');
    headers(res, { 'Content-Type': type, 'Cache-Control': html ? 'no-cache' : 'public, max-age=3600' });
    res.writeHead(200);
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file).pipe(res);
    return true;
  }

  // ---------- routes ----------
  // [method, pattern, handler(ctx, req, params, body), options]
  const routes = [];
  const route = (method, pattern, handler, o = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:([a-z]+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler, auth: o.auth !== false, limit: o.limit });
  };

  route('GET', '/healthz', () => ({ ok: true }), { auth: false });
  const supportEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.WAZIN_SUPPORT_EMAIL || '') ? env.WAZIN_SUPPORT_EMAIL : null;
  route('GET', '/api/config', () => ({ signup: allowSignup, ai: !!llm, support: supportEmail }), { auth: false });

  route('POST', '/api/signup', (ctx, req, p, body, res) => {
    if (!allowSignup) throw new AppError(404, 'not_found');
    const s = service.signup(body);
    setSession(res, s.token);
    return { user: s.user, csrf: s.csrf };
  }, { auth: false, limit: ['signup', 5, 3600e3] });

  route('POST', '/api/login', (ctx, req, p, body, res) => {
    const s = service.login(body);
    setSession(res, s.token);
    return { user: s.user, csrf: s.csrf };
  }, { auth: false, limit: ['login', Number(env.WAZIN_LOGIN_LIMIT) || 10, 60e3] });

  route('POST', '/api/logout', (ctx, req, p, b, res) => {
    service.logout(ctx.token);
    clearSession(res);
    return { ok: true };
  });

  route('GET', '/api/me', (ctx) => service.me(ctx));
  // Help page: visitors and signed-in users can both send a request (the signed-in route is CSRF-protected).
  route('POST', '/api/support', (ctx, r, p, b) => service.submitSupport(null, b), { auth: false, limit: ['support', 5, 3600e3] });
  route('POST', '/api/me/support', (ctx, r, p, b) => service.submitSupport(ctx, b), { limit: ['support', 5, 3600e3] });
  route('POST', '/api/me/password', (ctx, r, p, b) => (service.changePassword(ctx, b), { ok: true }));
  route('POST', '/api/me/profile', (ctx, r, p, b) => (service.updateProfile(ctx, b), service.me(service.authenticate(ctx.token))));
  route('GET', '/api/me/activity', (ctx) => service.myActivity(ctx));
  route('POST', '/api/me/sign-out-others', (ctx) => service.signOutOtherDevices(ctx));
  route('GET', '/api/dashboard', (ctx) => service.dashboard(ctx));
  route('GET', '/api/invoices', (ctx, req) => service.list(ctx, Object.fromEntries(new URL(req.url, 'http://x').searchParams)));
  route('POST', '/api/invoices', (ctx, r, p, b) => service.processNew(ctx, b.doc, 'upload'), { limit: ['upload', 60, 60e3] });
  route('GET', '/api/invoices/:id', (ctx, r, p) => service.view(ctx, p.id));
  route('POST', '/api/invoices/:id/:action', (ctx, r, p, b) => service.act(ctx, p.id, p.action, b), { limit: ['action', 120, 60e3] });
  route('GET', '/api/purchase-orders', (ctx) => service.listPOs(ctx));
  route('POST', '/api/purchase-orders', (ctx, r, p, b) => service.createPO(ctx, b));
  route('POST', '/api/goods-receipts', (ctx, r, p, b) => service.recordReceipt(ctx, b));
  route('GET', '/api/goods-receipts/:grn', (ctx, r, p) => service.deliveryReport(ctx, p.grn));
  route('GET', '/api/warehouse', (ctx) => service.warehouseOverview(ctx));
  route('GET', '/api/suppliers', (ctx) => service.listVendors(ctx));
  route('POST', '/api/suppliers', (ctx, r, p, b) => service.saveVendor(ctx, b));
  route('POST', '/api/import/:kind', (ctx, r, p, b) => service.importCSV(ctx, p.kind, b.csv));
  route('GET', '/api/audit', (ctx) => service.auditLog(ctx));
  route('GET', '/api/users', (ctx) => service.listUsers(ctx));
  route('POST', '/api/users', (ctx, r, p, b) => service.addUser(ctx, b));
  route('POST', '/api/users/:id/remove', (ctx, r, p) => (service.removeUser(ctx, p.id), { ok: true }));
  route('POST', '/api/settings', (ctx, r, p, b) => (service.updateSettings(ctx, b), service.me(service.authenticate(ctx.token))));
  // Scheduled payments for Treasury: what goes in the next payment file (the bank makes the transfer).
  const accountFor = (ctx) => {
    const full = ['admin', 'treasury'].includes(ctx.user.role);
    return (vat) => { const v = store.getVendor(ctx.org.id, vat)?.iban || ''; return full ? v : v ? `•••• ${v.slice(-4)}` : ''; };
  };
  route('GET', '/api/payments', (ctx) => {
    if (!['admin', 'finance', 'treasury'].includes(ctx.user.role)) throw new AppError(403, 'forbidden');
    const acc = accountFor(ctx);
    const all = store.ledger(ctx.org.id);
    const pending = all.filter((e) => !e.exportedAt).map((e) => ({ id: e.id, invoiceNumber: e.invoiceNumber, supplier: e.vendor, amount: e.payAmount ?? e.total, payOn: e.payOn, iban: acc(e.vendorVat) }))
      .sort((a, b) => String(a.payOn).localeCompare(String(b.payOn)));
    return { pending, sent: all.length - pending.length };
  });
  // The payment file. By default it holds only payments not yet handed to the bank, and marks them as handed over,
  // so downloading again can never pay a supplier twice. ?scope=all re-downloads the full history for records.
  route('GET', '/api/export/ledger.csv', (ctx, req, p, b, res) => {
    if (!['admin', 'finance', 'treasury'].includes(ctx.user.role)) throw new AppError(403, 'forbidden');
    const history = new URL(req.url, 'http://x').searchParams.get('scope') === 'all';
    const issue = !history && ['admin', 'treasury'].includes(ctx.user.role); // only Treasury hands payments to the bank
    const acc = accountFor(ctx);
    const all = store.ledger(ctx.org.id);
    const rows = history ? all : all.filter((e) => !e.exportedAt);
    const ts = new Date().toISOString();
    if (issue && rows.length) store.markExported(ctx.org.id, rows, ts);
    const head = ['invoice_id', 'invoice_number', 'supplier', 'supplier_vat', 'po_number', 'amount_ex_vat', 'input_vat', 'total', 'pay_amount', 'pay_on', 'beneficiary_iban', 'posted_by', 'sent_to_bank'];
    const lines = [head.join(','), ...rows.map((e) => [e.id, e.invoiceNumber, e.vendor, e.vendorVat, e.poNumber, e.amountExVat, e.inputVat, e.total, e.payAmount, e.payOn, acc(e.vendorVat), e.postedBy, e.exportedAt || (issue ? ts : '')].map(csvCell).join(','))];
    store.audit(ctx.org.id, ctx.user.email, 'ledger.exported', null, { rows: rows.length, scope: history ? 'all' : 'new', handedToBank: issue });
    headers(res, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="wazin-payments-${ts.slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' });
    res.writeHead(200);
    res.end(`\ufeff${lines.join('\r\n')}\r\n`);
    return undefined;
  });

  async function handle(req, res) {
    const t0 = Date.now();
    const reqId = randomToken(6);
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    let status = 500, ctx = null;
    try {
      if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(405, 'method_not_allowed');
        if (serveStatic(req, res, pathname)) { status = 200; return; }
        throw new AppError(404, 'not_found');
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(pathname)) ||
        (routes.some((x) => x.re.test(pathname)) ? null : undefined);
      if (r === null) throw new AppError(405, 'method_not_allowed');
      if (!r) throw new AppError(404, 'not_found');
      const params = {};
      const m = pathname.match(r.re);
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

      const gen = limiter.hit(`all:${ip(req)}`, 600, 60e3);
      if (gen) throw new AppError(429, 'rate_limited', { retryAfter: gen });
      if (r.limit) {
        const wait = limiter.hit(`${r.limit[0]}:${ip(req)}`, r.limit[1], r.limit[2]);
        if (wait) throw new AppError(429, 'rate_limited', { retryAfter: wait });
      }

      const token = parseCookies(req.headers.cookie)[COOKIE];
      if (r.auth) {
        const a = service.authenticate(token);
        if (!a) throw new AppError(401, 'not_signed_in');
        ctx = { ...a, token };
      }
      let body = {};
      if (req.method === 'POST') {
        // CSRF: same-origin check plus a per-session token header on every state change.
        const origin = req.headers.origin;
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        if (origin && new URL(origin).host !== host) throw new AppError(403, 'bad_origin');
        if (ctx && !safeEqual(req.headers['x-csrf-token'] || '', ctx.csrf)) throw new AppError(403, 'bad_csrf');
        body = await readBody(req);
      }
      const out = await r.handler(ctx, req, params, body, res);
      if (out !== undefined) send(res, 200, out);
      status = 200;
    } catch (e) {
      if (e instanceof AppError) {
        status = e.status;
        send(res, e.status, { error: e.code, detail: e.detail }, e.code === 'rate_limited' ? { 'Retry-After': String(e.detail?.retryAfter || 60) } : e.status === 413 ? { Connection: 'close' } : {});
      } else {
        status = 500;
        log('error', 'unhandled_error', { reqId, path: pathname, err: e?.message, stack: production ? undefined : e?.stack });
        if (!res.headersSent) send(res, 500, { error: 'server_error', reqId });
        else res.destroy();
      }
    } finally {
      log(status >= 500 ? 'error' : 'info', 'request', { reqId, method: req.method, path: pathname.replace(/\/WZN-\d+/, '/:id'), status, ms: Date.now() - t0, user: ctx?.user?.id, org: ctx?.org?.id });
    }
  }

  const server = http.createServer(handle);
  server.headersTimeout = 20000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;

  // Housekeeping: expired sessions and expired temporary workspaces.
  const sweep = () => {
    try {
      const s = store.deleteExpiredSessions(), d = store.deleteExpiredSandboxes();
      if (s || d) log('info', 'housekeeping', { sessions: s, demoWorkspaces: d });
    } catch (e) { log('error', 'housekeeping_failed', { err: e.message }); }
  };
  const timer = setInterval(sweep, 15 * 60e3);
  timer.unref();

  // Optional: a ready-made company with one account per team, for reviewers (WAZIN_SEED_PASSWORD).
  const ready = env.WAZIN_SEED_PASSWORD
    ? service.seedCompany({ password: env.WAZIN_SEED_PASSWORD }).then((r) => { if (r) log('info', 'seeded_company', { org: r }); }).catch((e) => log('error', 'seed_failed', { err: e.message }))
    : Promise.resolve();

  return {
    server, store, service, log, ready,
    close: () => new Promise((resolve) => { clearInterval(timer); server.close(() => { try { db.close(); } catch {} resolve(); }); }),
  };
}
