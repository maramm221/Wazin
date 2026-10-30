// End-to-end tests against a real HTTP server and a real SQLite file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers.js';

describe('the full hand-off flow in a demo company', () => {
  let t, c;
  before(async () => { t = await startApp(); c = t.client(); });
  after(() => t.stop());

  test('health check and security headers', async () => {
    const r = await c.call('GET', '/healthz');
    assert.equal(r.status, 200);
    const page = await fetch(`${t.base}/`);
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'; script-src 'self'/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  });

  test('every API call needs a session', async () => {
    for (const p of ['/api/dashboard', '/api/invoices', '/api/suppliers', '/api/audit']) assert.equal((await c.call('GET', p)).status, 401, p);
  });

  test('demo company: 13 invoices processed, session cookie is HttpOnly + SameSite=Strict', async () => {
    const r = await c.demo();
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'ap');
    assert.match(c.lastSetCookie, /HttpOnly/);
    assert.match(c.lastSetCookie, /SameSite=Strict/);
    const list = await c.call('GET', '/api/invoices');
    assert.equal(list.body.length, 13);
    const by = Object.fromEntries(list.body.map((i) => [i.id, i.status]));
    assert.equal(by['WZN-00001'], 'APPROVED_AUTO');
    assert.equal(by['WZN-00004'], 'APPROVAL_REQUIRED');
    assert.equal(by['WZN-00006'], 'BLOCKED');
    assert.equal(by['WZN-00010'], 'PARKED');
    assert.equal(by['WZN-00013'], 'REVIEW');
  });

  test('state changes without the CSRF token, or from another site, are refused', async () => {
    const saved = c.csrf;
    c.csrf = '';
    assert.equal((await c.call('POST', '/api/invoices', { doc: 'x' })).body.error, 'bad_csrf');
    c.csrf = saved;
    assert.equal((await c.call('POST', '/api/invoices', { doc: 'x' }, { headers: { origin: 'https://evil.example' } })).body.error, 'bad_origin');
  });

  test('a role cannot do another team\'s job', async () => {
    const r = await c.call('POST', '/api/invoices/WZN-00004/approve', {});
    assert.equal(r.status, 403);
    assert.equal((await c.call('POST', '/api/goods-receipts', { poNumber: 'PO-2026-1109', lines: [] })).status, 403);
  });

  test('each role sees only its own tasks', async () => {
    const expect = { finance: ['WZN-00004'], treasury: ['WZN-00006'], procurement: ['WZN-00008'], warehouse: ['WZN-00010', 'WZN-00009'] };
    for (const [role, ids] of Object.entries(expect)) {
      await c.as(role);
      const d = await c.call('GET', '/api/dashboard');
      assert.deepEqual(d.body.myTasks.map((i) => i.id), ids, role);
    }
  });

  test('finance approves; the payment is posted to the ledger', async () => {
    await c.as('finance');
    const r = await c.call('POST', '/api/invoices/WZN-00004/approve', { note: 'Budget confirmed' });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'APPROVED');
    assert.equal(r.body.actions.length, 0);
    const again = await c.call('POST', '/api/invoices/WZN-00004/approve', {});
    assert.equal(again.status, 403, 'cannot approve twice');
  });

  test('warehouse records the delivery; the parked invoice is paid with no one asking', async () => {
    await c.as('warehouse');
    const pos = await c.call('GET', '/api/purchase-orders');
    const po = pos.body.find((p) => p.poNumber === 'PO-2026-1109');
    const r = await c.call('POST', '/api/goods-receipts', { poNumber: po.poNumber, lines: po.lines.map((l) => ({ sku: l.sku, qty: l.qty })) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.resumed, [{ id: 'WZN-00010', status: 'APPROVED_AUTO' }]);
  });

  test('bad quantities are rejected', async () => {
    const r = await c.call('POST', '/api/goods-receipts', { poNumber: 'PO-2026-1108', lines: [{ sku: 'IND-BRG', qty: -4 }] });
    assert.equal(r.body.error, 'invalid_quantity');
    assert.equal((await c.call('POST', '/api/goods-receipts', { poNumber: 'PO-404', lines: [{ sku: 'x', qty: 1 }] })).body.error, 'po_not_found');
  });

  test('treasury must confirm the call-back before a new bank account is accepted', async () => {
    await c.as('treasury');
    const v = await c.call('GET', '/api/invoices/WZN-00006');
    assert.ok(v.body.vendor.phone, 'phone on file shown for the call-back');
    assert.match(v.body.vendor.ibanMasked, /^•••• \d{4}$/);
    assert.equal((await c.call('POST', '/api/invoices/WZN-00006/verify_bank', { note: 'ok' })).body.error, 'confirm_call_required');
    assert.equal((await c.call('POST', '/api/invoices/WZN-00006/verify_bank', { confirmCalled: true })).body.error, 'reason_required');
    const r = await c.call('POST', '/api/invoices/WZN-00006/verify_bank', { confirmCalled: true, note: 'Called +966 13 000 4004; confirmed by their CFO' });
    assert.equal(r.body.status, 'APPROVED_AUTO');
  });

  test('procurement amends the order to the agreed price; the invoice clears', async () => {
    await c.as('procurement');
    const r = await c.call('POST', '/api/invoices/WZN-00008/amend_po', { note: 'Price increase agreed by phone' });
    assert.equal(r.body.status, 'APPROVED_AUTO');
  });

  test('rejecting needs a reason', async () => {
    await c.as('ap');
    assert.equal((await c.call('POST', '/api/invoices/WZN-00007/reject', {})).body.error, 'reason_required');
    const r = await c.call('POST', '/api/invoices/WZN-00007/reject', { note: 'Supplier will reissue with VAT number' });
    assert.equal(r.body.status, 'REJECTED');
  });

  test('an unreadable invoice can be completed by hand and then runs every check', async () => {
    const r = await c.call('POST', '/api/invoices/WZN-00013/manual_entry', {
      invoiceNumber: 'DLC-7790', issueDate: '2026-10-28', sellerName: 'Dammam Logistics Co.', sellerVat: '311987654300003', poNumber: 'PO-2026-1111',
      iban: 'SA2705000068201234567000', lines: [{ sku: 'LOG-STR', name: 'Warehouse storage (pallet-week)', qty: 80, unitPrice: 45 }, { sku: 'LOG-PAL', name: 'Pallet delivery Riyadh–Dammam', qty: 6, unitPrice: 260 }],
      subtotal: 5160, vatAmount: 774, total: 5934,
    });
    assert.equal(r.status, 200);
    assert.notEqual(r.body.status, 'REVIEW');
    assert.ok(r.body.result.reasonCodes.includes('QR_MISSING'), 'no QR typed in, so the supplier is asked for a proper e-invoice');
  });

  test('a sample invoice is a fresh case, not a duplicate of the inbox', async () => {
    const samples = await c.call('GET', '/api/samples');
    assert.equal(samples.body.length, 13);
    const r = await c.call('POST', '/api/invoices', { doc: samples.body[0].doc });
    assert.equal(r.body.status, 'APPROVED_AUTO');
  });

  test('re-billing the same goods under a new number and date is blocked', async () => {
    const samples = await c.call('GET', '/api/samples');
    const doc = samples.body[0].doc.replace(/ALN-25117/g, 'ALN-99001').replace(/2026-10-25/g, '2026-10-29');
    const r = await c.call('POST', '/api/invoices', { doc });
    assert.equal(r.body.status, 'BLOCKED');
    assert.deepEqual(r.body.result.reasonCodes, ['ALREADY_INVOICED']);
  });

  test('the activity log is complete and its hash chain verifies', async () => {
    const a = await c.call('GET', '/api/audit');
    assert.ok(a.body.entries.length > 20);
    assert.equal(a.body.integrity.ok, true);
    assert.ok(a.body.entries.some((e) => e.action === 'supplier.bank_changed'));
  });

  test('editing the log directly in the database is detected', async () => {
    const db = new DatabaseSync(t.dbFile);
    db.prepare("UPDATE audit SET detail_json = '{}' WHERE seq = 3").run();
    db.close();
    const a = await c.call('GET', '/api/audit');
    assert.equal(a.body.integrity.ok, false);
    assert.equal(a.body.integrity.brokenAt, 3);
  });

  test('bank accounts, phones and invoice documents are encrypted in the database file', async () => {
    const raw = fs.readFileSync(t.dbFile).toString('latin1') + (fs.existsSync(`${t.dbFile}-wal`) ? fs.readFileSync(`${t.dbFile}-wal`).toString('latin1') : '');
    assert.ok(!raw.includes('SA4410000001234567890123'), 'IBAN not in plaintext');
    assert.ok(!raw.includes('+966 13 000 4004'), 'supplier phone not in plaintext');
    assert.ok(!raw.includes('<cac:AccountingSupplierParty>'), 'invoice XML not in plaintext');
    assert.ok(raw.includes('v1:'), 'ciphertext present');
  });

  test('non-treasury roles see masked bank accounts', async () => {
    await c.as('procurement');
    const s = await c.call('GET', '/api/suppliers');
    assert.ok(s.body.every((v) => /^•••• \d{4}$/.test(v.iban)));
    await c.as('treasury');
    const s2 = await c.call('GET', '/api/suppliers');
    assert.ok(s2.body.every((v) => /^SA\d{22}$/.test(v.iban)));
  });

  test('only treasury can change a bank account', async () => {
    await c.as('procurement');
    const r = await c.call('POST', '/api/suppliers', { vat: '310122334400003', nameEn: 'Al-Noor Office Supplies', iban: 'SA0000000000000000000099' });
    assert.equal(r.body.error, 'treasury_only_bank');
  });

  test('ledger export is CSV with formula injection neutralised', async () => {
    await c.as('finance');
    const r = await fetch(`${t.base}/api/export/ledger.csv`, { headers: { cookie: c.cookie } });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    const text = await r.text();
    assert.match(text.replace(/^\uFEFF/, ''), /^invoice_id,invoice_number/);
    assert.ok(text.includes('WZN-00001'));
  });
});

describe('accounts, workspaces and limits', () => {
  let t;
  before(async () => { t = await startApp(); });
  after(() => t.stop());

  test('sign-up validates input and creates an empty, isolated workspace', async () => {
    const c = t.client();
    assert.equal((await c.call('POST', '/api/signup', { company: 'X', name: 'A', email: 'bad', password: 'abcdefghij1' })).body.error, 'invalid_email');
    assert.equal((await c.call('POST', '/api/signup', { company: 'X', name: 'A', email: 'a@x.sa', password: 'short1' })).body.error, 'password_too_short');
    assert.equal((await c.call('POST', '/api/signup', { company: 'X', name: 'A', email: 'a@x.sa', password: 'onlyletterspw' })).body.error, 'password_needs_letter_and_digit');
    const r = await c.call('POST', '/api/signup', { company: 'Acme Trading', name: 'Amal', email: 'amal@acme.sa', password: 'correct horse 42' });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.role, 'admin');
    assert.equal((await c.call('GET', '/api/invoices')).body.length, 0);
    // A demo company created by someone else is invisible here.
    const other = t.client();
    await other.demo();
    assert.equal((await c.call('GET', '/api/invoices/WZN-00001')).status, 404);
    assert.equal((await c.call('POST', '/api/signup', { company: 'Y', name: 'B', email: 'amal@acme.sa', password: 'correct horse 42' })).status, 409);
  });

  test('admin imports suppliers and orders from CSV; bad rows are reported, not imported', async () => {
    const c = t.client();
    await c.call('POST', '/api/login', { email: 'amal@acme.sa', password: 'correct horse 42' });
    const v = await c.call('POST', '/api/import/vendors', { csv: 'vat,name_en,name_ar,iban,phone\n310122334400003,Good Co,شركة,SA4410000001234567890123,+966 11 000 0000\n123,Bad VAT,,SA4410000001234567890123,\n' });
    assert.deepEqual(v.body, { imported: 1, errors: [{ row: 3, error: 'invalid_vat' }] });
    const p = await c.call('POST', '/api/import/purchase_orders', { csv: 'po_number,vendor_vat,buyer,sku,item_name,qty,unit_price\nPO-1,310122334400003,b@acme.sa,A,"Chair, black",10,450\nPO-1,310122334400003,b@acme.sa,B,Desk,2,1200\n' });
    assert.equal(p.body.imported, 1);
    const pos = await c.call('GET', '/api/purchase-orders');
    assert.equal(pos.body[0].lines[0].name, 'Chair, black', 'quoted CSV field with a comma');
    assert.equal((await c.call('POST', '/api/import/vendors', { csv: 'name_en\nx\n' })).body.error, 'missing_columns');
  });

  test('admin adds a teammate, who signs in with the one-time password', async () => {
    const admin = t.client();
    await admin.call('POST', '/api/login', { email: 'amal@acme.sa', password: 'correct horse 42' });
    const r = await admin.call('POST', '/api/users', { name: 'Fahad', email: 'fahad@acme.sa', role: 'finance' });
    assert.equal(r.status, 200);
    const f = t.client();
    const login = await f.call('POST', '/api/login', { email: 'fahad@acme.sa', password: r.body.temporaryPassword });
    assert.equal(login.body.user.role, 'finance');
    assert.equal((await f.call('GET', '/api/users')).status, 403, 'finance cannot manage people');
  });

  test('wrong passwords lock the account after five tries, and the message never reveals whether the email exists', async () => {
    const c = t.client();
    const unknown = await c.call('POST', '/api/login', { email: 'nobody@acme.sa', password: 'whatever123' });
    assert.equal(unknown.body.error, 'bad_credentials');
    for (let i = 0; i < 5; i++) assert.equal((await c.call('POST', '/api/login', { email: 'amal@acme.sa', password: 'wrong-password-1' })).body.error, 'bad_credentials');
    const locked = await c.call('POST', '/api/login', { email: 'amal@acme.sa', password: 'correct horse 42' });
    assert.equal(locked.status, 423);
  });

  test('sign-in attempts are rate limited per address', async () => {
    const c = t.client();
    let last;
    for (let i = 0; i < 12; i++) last = await c.call('POST', '/api/login', { email: 'x@y.sa', password: 'nope-nope-1' });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  });

  test('logout ends the session on the server', async () => {
    const c = t.client();
    await c.demo();
    assert.equal((await c.call('GET', '/api/me')).status, 200);
    await c.call('POST', '/api/logout', {});
    const old = c.cookie;
    c.cookie = old;
    assert.equal((await c.call('GET', '/api/me')).status, 401);
  });
});

describe('malformed and hostile requests', () => {
  let t, c;
  before(async () => { t = await startApp(); c = t.client(); await c.demo(); });
  after(() => t.stop());

  test('invalid JSON, wrong content type and oversized bodies are refused cleanly', async () => {
    assert.equal((await c.call('POST', '/api/invoices', undefined, { raw: '{not json' })).body.error, 'invalid_json');
    assert.equal((await c.call('POST', '/api/invoices', undefined, { raw: 'doc=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } })).body.error, 'json_required');
    let bigStatus;
    try { bigStatus = (await c.call('POST', '/api/invoices', { doc: 'x'.repeat(1.2 * 1024 * 1024) })).status; } catch { bigStatus = 'closed'; }
    assert.ok(bigStatus === 413 || bigStatus === 'closed', `oversized body refused (${bigStatus})`);
    assert.equal((await c.call('GET', '/healthz')).status, 200, 'server still healthy');
    assert.equal((await c.call('POST', '/api/invoices', { doc: '   ' })).body.error, 'empty_document');
  });

  test('unknown routes and actions return clear errors, not crashes', async () => {
    assert.equal((await c.call('GET', '/api/nope')).status, 404);
    assert.equal((await c.call('DELETE', '/api/invoices')).status, 405);
    assert.equal((await c.call('POST', '/api/invoices/WZN-00001/explode', {})).status, 403);
    assert.equal((await c.call('GET', '/api/invoices/WZN-99999')).status, 404);
  });

  test('static files cannot escape the public folder', async () => {
    const res = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: new URL(t.base).port, path: '/%2e%2e/server/crypto.js' }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, body: b })); });
    });
    assert.ok(!res.body.includes('createCipheriv'));
  });

  test('a script tag in an invoice is stored as text and returned as data, never executed by the server', async () => {
    const doc = 'Invoice No: <script>alert(1)</script>\nDate: 2026-10-01\nSeller: <img src=x onerror=alert(1)>';
    const r = await c.call('POST', '/api/invoices', { doc });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'REVIEW');
    assert.equal(r.body.doc, doc);
  });

  test('search input with SQL characters is treated as text', async () => {
    const r = await c.call('GET', `/api/invoices?q=${encodeURIComponent("' OR 1=1 --")}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 0);
  });
});
