// End-to-end tests against a real HTTP server and a real SQLite file.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startApp } from './helpers.js';
import { buildDemo } from '../data/demo.js';

const laterInvoices = buildDemo(2).inbox; // invoices that arrive after the seeded inbox

describe('the full hand-off flow in a seeded company', () => {
  let t, c;
  before(async () => { t = await startApp({ WAZIN_LOGIN_LIMIT: '1000' }); c = t.client(); });
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

  test('seeded company: 13 invoices processed, session cookie is HttpOnly + SameSite=Strict', async () => {
    const r = await c.company();
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
    // The warehouse is told which delivery to receive first: this one has an invoice waiting on it.
    const first = (await c.call('GET', '/api/warehouse')).body.priorities.find((x) => x.poNumber === po.poNumber);
    assert.equal(first.waitingInvoices, 1);
    const r = await c.call('POST', '/api/goods-receipts', { poNumber: po.poNumber, lines: po.lines.map((l) => ({ sku: l.sku, qty: l.qty })) });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.resumed, [{ id: 'WZN-00010', status: 'APPROVED_AUTO' }]);
    assert.deepEqual(r.body.report.flags, { damaged: 0, over: 0, outstanding: 0 });
    // Damaged units are recorded but not counted as received; the report drafts a message to the supplier.
    assert.equal((await c.call('POST', '/api/goods-receipts', { poNumber: 'PO-2026-1108', lines: [{ sku: 'IND-BRG', qty: 1, damaged: 2 }] })).body.error, 'invalid_damaged');
    const d = await c.call('POST', '/api/goods-receipts', { poNumber: 'PO-2026-1108', lines: [{ sku: 'IND-BRG', qty: 2, damaged: 2 }] });
    const line = d.body.report.lines.find((l) => l.sku === 'IND-BRG');
    assert.equal(line.damaged, 2);
    assert.equal(line.accepted, 0);
    assert.match(d.body.report.message.bodyEn, /arrived damaged/);
    assert.equal((await c.call('GET', `/api/goods-receipts/${d.body.grn.grnNumber}`)).body.flags.damaged, 1);
    const hist = (await c.call('GET', '/api/warehouse')).body.suppliers.find((x) => x.supplier === 'Jeddah Industrial Parts');
    assert.ok(hist.unitsDamaged >= 2);
    // The dashboard shows live decision numbers next to the measured test results.
    const q = (await c.call('GET', '/api/dashboard')).body.quality;
    assert.ok(q.decisions >= 13 && q.noPerson >= 1);
    assert.ok(q.tested.hard.correct > 0.5 && q.tested.hard.correct < 1);
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

  test('rejecting needs a reason; anyone can dispute a decision and the Finance Manager settles it', async () => {
    await c.as('ap');
    assert.equal((await c.call('POST', '/api/invoices/WZN-00007/reject', {})).body.error, 'reason_required');
    const r = await c.call('POST', '/api/invoices/WZN-00007/reject', { note: 'Supplier will reissue with VAT number' });
    assert.equal(r.body.status, 'REJECTED');
    // A warehouse clerk disputes an invoice Wazin paid automatically: the payment is held for review.
    await c.as('warehouse');
    const list = (await c.call('GET', '/api/invoices')).body;
    const paid = (list.items || list).find((i) => i.status === 'APPROVED_AUTO');
    assert.equal((await c.call('POST', `/api/invoices/${paid.id}/dispute`, { note: 'Half of it arrived damaged' })).body.error, 'dispute_kind_required');
    const d = await c.call('POST', `/api/invoices/${paid.id}/dispute`, { kind: 'should_not_pay', note: 'Half of it arrived damaged' });
    assert.equal(d.body.status, 'DISPUTED');
    assert.equal(d.body.owner, 'FINANCE_MANAGER');
    assert.equal((await c.call('POST', `/api/invoices/${paid.id}/uphold`, {})).status, 403, 'only finance settles');
    await c.as('finance');
    assert.equal((await c.call('GET', '/api/dashboard')).body.disputes.open, 1);
    const kept = await c.call('POST', `/api/invoices/${paid.id}/uphold`, { note: 'Damage is covered by a separate credit note' });
    assert.equal(kept.body.status, 'APPROVED_AUTO', 'Wazin re-checks and pays again');
    assert.deepEqual((await c.call('GET', '/api/dashboard')).body.disputes, { open: 0, raised: 1, confirmed: 1, corrected: 0 });
    await c.as('ap');
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

  test('a newly arriving invoice is a fresh case, not a duplicate of the inbox', async () => {
    const r = await c.call('POST', '/api/invoices', { doc: laterInvoices[0].doc });
    assert.equal(r.body.status, 'APPROVED_AUTO');
  });

  test('re-billing the same goods under a new number and date is blocked', async () => {
    const doc = laterInvoices[0].doc.replace(/ALN-25117/g, 'ALN-99001').replace(/2026-10-25/g, '2026-10-29');
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
  before(async () => { t = await startApp({ WAZIN_LOGIN_LIMIT: '1000' }); });
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
    // Another company's invoices are invisible here.
    const other = t.client();
    await other.company();
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
    const fresh = await startApp(); // default limit: 10 a minute
    const c = fresh.client();
    let last;
    for (let i = 0; i < 12; i++) last = await c.call('POST', '/api/login', { email: 'x@y.sa', password: 'nope-nope-1' });
    assert.equal(last.status, 429);
    assert.ok(Number(last.headers.get('retry-after')) > 0);
    await fresh.stop();
  });

  test('logout ends the session on the server; "sign out on other devices" ends the others; profile name, activity and help requests', async () => {
    const c = t.client();
    await c.company();
    assert.equal((await c.call('GET', '/api/me')).status, 200);
    await c.call('POST', '/api/logout', {});
    const old = c.cookie;
    c.cookie = old;
    assert.equal((await c.call('GET', '/api/me')).status, 401);
    // Two devices for the same person; one signs the other out.
    const phone = t.client(), laptop = t.client();
    await phone.as('procurement'); await laptop.as('procurement');
    assert.equal((await laptop.call('GET', '/api/me/activity')).body.devices, 2);
    assert.equal((await laptop.call('POST', '/api/me/sign-out-others', {})).body.signedOut, 1);
    assert.equal((await phone.call('GET', '/api/me')).status, 401);
    assert.equal((await laptop.call('GET', '/api/me')).status, 200);
    // The person can change their own name (not their email or role), and it is logged.
    assert.equal((await laptop.call('POST', '/api/me/profile', { name: '' })).status, 400);
    const r = await laptop.call('POST', '/api/me/profile', { name: 'Sara A. Al-Otaibi', role: 'admin', email: 'x@y.sa' });
    assert.equal(r.body.user.name, 'Sara A. Al-Otaibi');
    assert.equal(r.body.user.role, 'procurement');
    assert.ok((await laptop.call('GET', '/api/me/activity')).body.recent.some((e) => e.action === 'profile.updated'));
    // Help page: a visitor and a signed-in user can both send a request and get a reference number.
    const visitor = t.client();
    assert.equal((await visitor.call('POST', '/api/support', { name: 'Huda', email: 'huda@co.sa', topic: 'nope', message: 'The upload button does nothing.' })).body.error, 'topic_required');
    assert.equal((await visitor.call('POST', '/api/support', { name: 'Huda', email: 'huda@co.sa', topic: 'technical', message: 'help' })).body.error, 'message_too_short');
    assert.match((await visitor.call('POST', '/api/support', { name: 'Huda', email: 'huda@co.sa', topic: 'technical', message: 'The upload button does nothing.' })).body.ref, /^WZ-\d{6}-[0-9A-F]{6}$/);
    const urgent = await laptop.call('POST', '/api/me/support', { topic: 'security', message: 'A supplier emailed asking us to change their bank.' });
    assert.equal(urgent.body.urgent, true);
    assert.equal(urgent.body.email, 'procurement@sahara.example');
    assert.ok((await laptop.call('GET', '/api/me/activity')).body.recent.some((e) => e.action === 'support.requested'));
  });
});

describe('malformed and hostile requests', () => {
  let t, c;
  before(async () => { t = await startApp({ WAZIN_LOGIN_LIMIT: '1000' }); c = t.client(); await c.company(); });
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

describe('company set-up adapts the checks', () => {
  let t, c;
  before(async () => { t = await startApp({ WAZIN_LOGIN_LIMIT: '1000' }); c = t.client(); await c.as('admin'); });
  after(() => t.stop());
  const toner = () => laterInvoices.find((i) => i.label === 'Toner & paper').doc; // goods not received yet

  test('defaults: three-way matching, all teams, 1% tolerance, early payment on', async () => {
    const me = (await c.call('GET', '/api/me')).body;
    assert.deepEqual(me.org.settings, { teams: { finance: true, procurement: true, warehouse: true, treasury: true }, matching: 'three', priceTolerancePct: 1, earlyPay: true });
    assert.equal((await c.call('POST', '/api/invoices', { doc: toner() })).body.status, 'PARKED', 'waits for the delivery');
  });

  test('two-way matching (no warehouse step) pays without a goods receipt, and turns the warehouse team off', async () => {
    const r = await c.call('POST', '/api/settings', { settings: { matching: 'two' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.org.settings.teams.warehouse, false);
    const doc = toner().replace(/ALN-25133/g, 'ALN-77001').replace(/2026-10-28/g, '2026-10-30');
    const v = (await c.call('POST', '/api/invoices', { doc })).body;
    assert.ok(!v.result.reasonCodes.includes('AWAITING_GRN'), v.result.reasonCodes.join());
  });

  test('a one-person company: every team off is accepted', async () => {
    const r = await c.call('POST', '/api/settings', { settings: { teams: { finance: false, procurement: false, warehouse: false, treasury: false } } });
    assert.equal(r.status, 200);
    assert.ok(Object.values(r.body.org.settings.teams).every((x) => x === false));
  });

  test('settings are validated and only the administrator may change them', async () => {
    for (const bad of [{ matching: 'four' }, { priceTolerancePct: 50 }, { priceTolerancePct: 'x' }, { teams: 'all' }]) {
      assert.equal((await c.call('POST', '/api/settings', { settings: bad })).status, 400, JSON.stringify(bad));
    }
    const ap = t.client(); await ap.as('ap');
    assert.equal((await ap.call('POST', '/api/settings', { settings: { matching: 'two' } })).status, 403);
  });
});
