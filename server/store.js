// Data access for one database. All reads and writes are scoped by org_id, and sensitive
// columns are encrypted/decrypted here so nothing else in the server handles ciphertext.
import crypto from 'node:crypto';
import { encrypt, decrypt, sha256 } from './crypto.js';
import { tx } from './db.js';

/** How a company works. Sensible defaults; each company can change them in Settings.
 *  teams: which separate teams exist (when a team is off, its tasks go to the administrator).
 *  matching: 'three' = order + goods received, 'two' = order only (services, no warehouse). */
export const DEFAULT_SETTINGS = Object.freeze({
  teams: Object.freeze({ finance: true, procurement: true, warehouse: true, treasury: true }),
  matching: 'three', priceTolerancePct: 1, earlyPay: true,
});

const now = () => Date.now();
const json = (s, d) => (s ? JSON.parse(s) : d);

export class Store {
  constructor(db, key) {
    this.db = db;
    this.key = key;
    this.q = new Map();
  }
  #p(sql) {
    let s = this.q.get(sql);
    if (!s) this.q.set(sql, (s = this.db.prepare(sql)));
    return s;
  }
  enc(org, field, v) { return encrypt(this.key, v, `${org}:${field}`); }
  dec(org, field, v) { return decrypt(this.key, v, `${org}:${field}`); }
  tx(fn) { return tx(this.db, fn); }

  // ---------- orgs ----------
  createOrg({ name, kind, approvalLimit = 50000, ttlMs, settings }) {
    const id = `org_${crypto.randomUUID()}`;
    this.#p('INSERT INTO orgs (id,name,kind,approval_limit,created_at,expires_at) VALUES (?,?,?,?,?,?)')
      .run(id, name, kind, approvalLimit, now(), ttlMs ? now() + ttlMs : null);
    if (settings) this.updateOrg(id, { settings });
    return this.getOrg(id);
  }
  getOrg(id) {
    const r = this.#p('SELECT * FROM orgs WHERE id = ?').get(id);
    let saved = {};
    try { saved = JSON.parse(r?.settings_json || '{}'); } catch { /* keep defaults */ }
    return r && { id: r.id, name: r.name, kind: r.kind, approvalLimit: r.approval_limit, settings: { ...DEFAULT_SETTINGS, ...saved, teams: { ...DEFAULT_SETTINGS.teams, ...(saved.teams || {}) } }, createdAt: r.created_at, expiresAt: r.expires_at };
  }
  updateOrg(id, { name, approvalLimit, settings }) {
    if (settings !== undefined) this.#p('UPDATE orgs SET settings_json = ? WHERE id = ?').run(JSON.stringify(settings), id);
    if (name !== undefined) this.#p('UPDATE orgs SET name = ? WHERE id = ?').run(name, id);
    if (approvalLimit !== undefined) this.#p('UPDATE orgs SET approval_limit = ? WHERE id = ?').run(approvalLimit, id);
  }
  deleteExpiredSandboxes() {
    return this.#p("DELETE FROM orgs WHERE kind = 'sandbox' AND expires_at IS NOT NULL AND expires_at < ?").run(now()).changes;
  }

  // ---------- support requests ----------
  /** Save a Help-page request. Contact details and the message are encrypted under the 'support' key context. */
  addSupportRequest({ ref, orgId, userId, topic, name, email, message }) {
    this.#p('INSERT INTO support_requests (ref,org_id,user_id,topic,contact_enc,message_enc,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(ref, orgId || null, userId || null, topic, this.enc('support', 'contact', JSON.stringify({ name, email })), this.enc('support', 'message', message), now());
  }
  getSupportRequest(ref) {
    const r = this.#p('SELECT * FROM support_requests WHERE ref = ?').get(ref);
    return r && { ref: r.ref, orgId: r.org_id, userId: r.user_id, topic: r.topic, status: r.status, createdAt: r.created_at, ...JSON.parse(this.dec('support', 'contact', r.contact_enc)), message: this.dec('support', 'message', r.message_enc) };
  }

  // ---------- users & sessions ----------
  createUser({ orgId, email, name, role, pwHash }) {
    const id = `usr_${crypto.randomUUID()}`;
    this.#p('INSERT INTO users (id,org_id,email,name,role,pw_hash,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, orgId, email.toLowerCase(), name, role, pwHash, now());
    return this.getUser(id);
  }
  #user(r) {
    return r && { id: r.id, orgId: r.org_id, email: r.email, name: r.name, role: r.role, pwHash: r.pw_hash, failedLogins: r.failed_logins, lockedUntil: r.locked_until };
  }
  getUser(id) { return this.#user(this.#p('SELECT * FROM users WHERE id = ?').get(id)); }
  getUserByEmail(email) { return this.#user(this.#p('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase())); }
  listUsers(orgId) { return this.#p('SELECT * FROM users WHERE org_id = ? ORDER BY created_at').all(orgId).map((r) => this.#user(r)); }
  setLoginState(id, failed, lockedUntil) { this.#p('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?').run(failed, lockedUntil, id); }
  setPassword(id, pwHash) { this.#p('UPDATE users SET pw_hash = ? WHERE id = ?').run(pwHash, id); this.#p('DELETE FROM sessions WHERE user_id = ?').run(id); }
  setName(id, name) { this.#p('UPDATE users SET name = ? WHERE id = ?').run(name, id); }
  countSessions(userId) { return this.#p('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(userId, now()).n; }
  /** Sign a user out everywhere except the session making the request. */
  deleteOtherSessions(userId, keepToken) { return this.#p('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, sha256(keepToken)).changes; }
  deleteUser(orgId, id) { return this.#p('DELETE FROM users WHERE id = ? AND org_id = ?').run(id, orgId).changes; }

  createSession(userId, token, csrf, ttlMs) {
    this.#p('INSERT INTO sessions (token_hash,user_id,csrf,created_at,expires_at) VALUES (?,?,?,?,?)').run(sha256(token), userId, csrf, now(), now() + ttlMs);
  }
  getSession(token) {
    const r = this.#p('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?').get(sha256(token), now());
    return r && { userId: r.user_id, csrf: r.csrf, expiresAt: r.expires_at };
  }
  deleteSession(token) { this.#p('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token)); }
  deleteExpiredSessions() { return this.#p('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes; }

  // ---------- vendors ----------
  upsertVendor(org, v) {
    this.#p(`INSERT INTO vendors (org_id,vat,name_en,name_ar,iban_enc,phone_enc,email_enc,terms_days,discount_pct,discount_days,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(org_id,vat) DO UPDATE SET name_en=excluded.name_en, name_ar=excluded.name_ar, iban_enc=excluded.iban_enc,
               phone_enc=excluded.phone_enc, email_enc=excluded.email_enc, terms_days=excluded.terms_days,
               discount_pct=excluded.discount_pct, discount_days=excluded.discount_days, updated_at=excluded.updated_at`)
      .run(org, v.vat, v.nameEn, v.nameAr || '', this.enc(org, 'iban', v.iban), v.phone ? this.enc(org, 'phone', v.phone) : null,
        v.email ? this.enc(org, 'email', v.email) : null, v.paymentTermsDays ?? 30, v.earlyPayDiscount?.pct ?? 0, v.earlyPayDiscount?.days ?? 0, now());
  }
  #vendor(org, r) {
    return r && {
      vat: r.vat, nameEn: r.name_en, nameAr: r.name_ar, iban: this.dec(org, 'iban', r.iban_enc),
      phone: r.phone_enc ? this.dec(org, 'phone', r.phone_enc) : '', email: r.email_enc ? this.dec(org, 'email', r.email_enc) : '',
      paymentTermsDays: r.terms_days, earlyPayDiscount: r.discount_pct > 0 ? { pct: r.discount_pct, days: r.discount_days } : null,
    };
  }
  getVendor(org, vat) { return this.#vendor(org, this.#p('SELECT * FROM vendors WHERE org_id = ? AND vat = ?').get(org, vat)); }
  findVendorByName(org, name) {
    const n = String(name).trim();
    return this.#vendor(org, this.#p('SELECT * FROM vendors WHERE org_id = ? AND (lower(name_en) = lower(?) OR name_ar = ?)').get(org, n, n));
  }
  listVendors(org) { return this.#p('SELECT * FROM vendors WHERE org_id = ? ORDER BY name_en').all(org).map((r) => this.#vendor(org, r)); }

  // ---------- purchase orders & goods receipts ----------
  upsertPO(org, po) {
    this.#p(`INSERT INTO purchase_orders (org_id,po_number,vendor_vat,buyer,lines_json,updated_at) VALUES (?,?,?,?,?,?)
             ON CONFLICT(org_id,po_number) DO UPDATE SET vendor_vat=excluded.vendor_vat, buyer=excluded.buyer, lines_json=excluded.lines_json, updated_at=excluded.updated_at`)
      .run(org, po.poNumber, po.vendorVat, po.buyer || '', JSON.stringify(po.lines), now());
  }
  #po(r) { return r && { poNumber: r.po_number, vendorVat: r.vendor_vat, buyer: r.buyer, lines: json(r.lines_json, []) }; }
  getPO(org, n) { return this.#po(this.#p('SELECT * FROM purchase_orders WHERE org_id = ? AND po_number = ?').get(org, String(n).trim())); }
  listPOs(org) { return this.#p('SELECT * FROM purchase_orders WHERE org_id = ? ORDER BY po_number DESC').all(org).map((r) => this.#po(r)); }
  addGRN(org, g, by) {
    this.#p('INSERT INTO goods_receipts (org_id,grn_number,po_number,lines_json,received_by,created_at) VALUES (?,?,?,?,?,?)')
      .run(org, g.grnNumber, g.poNumber, JSON.stringify(g.lines), by || null, now());
  }
  getGRNs(org, po) {
    return this.#p('SELECT * FROM goods_receipts WHERE org_id = ? AND po_number = ? ORDER BY created_at, grn_number').all(org, po)
      .map((r) => ({ grnNumber: r.grn_number, poNumber: r.po_number, lines: json(r.lines_json, []), receivedBy: r.received_by, createdAt: r.created_at }));
  }
  getGRN(org, n) {
    const r = this.#p('SELECT * FROM goods_receipts WHERE org_id = ? AND grn_number = ?').get(org, String(n));
    return r && { grnNumber: r.grn_number, poNumber: r.po_number, lines: json(r.lines_json, []), receivedBy: r.received_by, createdAt: r.created_at };
  }
  /** Every goods receipt of the company, for the warehouse's supplier history. */
  listGRNs(org) {
    return this.#p('SELECT * FROM goods_receipts WHERE org_id = ? ORDER BY created_at, grn_number').all(org)
      .map((r) => ({ grnNumber: r.grn_number, poNumber: r.po_number, lines: json(r.lines_json, []), receivedBy: r.received_by, createdAt: r.created_at }));
  }
  grnExists(org, n) { return !!this.#p('SELECT 1 FROM goods_receipts WHERE org_id = ? AND grn_number = ?').get(org, n); }
  nextGrnNumber(org) {
    const c = this.#p('SELECT COUNT(*) AS c FROM goods_receipts WHERE org_id = ?').get(org).c;
    let n = c + 1;
    while (this.grnExists(org, `GRN-${String(n).padStart(5, '0')}`)) n++;
    return `GRN-${String(n).padStart(5, '0')}`;
  }

  // ---------- invoices ----------
  nextInvoiceId(org) {
    const r = this.#p('SELECT COALESCE(MAX(seq),0) AS m FROM invoices WHERE org_id = ?').get(org);
    return { seq: r.m + 1, id: `WZN-${String(r.m + 1).padStart(5, '0')}` };
  }
  saveInvoice(org, rec) {
    const r = rec.result;
    const inv = r.invoice || {};
    this.#p(`INSERT INTO invoices (org_id,id,seq,invoice_number,vendor_vat,vendor_name,po_number,total,status,owner,source,doc_enc,result_enc,history_enc,dup_key,fp_key,parked,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT(org_id,id) DO UPDATE SET invoice_number=excluded.invoice_number, vendor_vat=excluded.vendor_vat, vendor_name=excluded.vendor_name,
               po_number=excluded.po_number, total=excluded.total, status=excluded.status, owner=excluded.owner, doc_enc=excluded.doc_enc,
               result_enc=excluded.result_enc, history_enc=excluded.history_enc, dup_key=excluded.dup_key, fp_key=excluded.fp_key,
               parked=excluded.parked, updated_at=excluded.updated_at`)
      .run(org, rec.id, rec.seq, inv.invoiceNumber ?? null, r.vendorVat || inv.sellerVat || null, r.vendorName || inv.sellerName || null,
        inv.poNumber ?? null, Number.isFinite(inv.total) ? inv.total : null, rec.status, rec.owner, rec.source,
        this.enc(org, 'doc', rec.doc), this.enc(org, 'result', JSON.stringify(r)), this.enc(org, 'history', JSON.stringify(rec.history || [])),
        rec.dupKey ?? null, rec.fpKey ?? null, rec.parked ? 1 : 0, rec.createdAt ?? now(), now());
  }
  #inv(org, r, full) {
    if (!r) return r;
    const base = { id: r.id, seq: r.seq, invoiceNumber: r.invoice_number, vendorVat: r.vendor_vat, vendorName: r.vendor_name, poNumber: r.po_number,
      total: r.total, status: r.status, owner: r.owner, source: r.source, parked: !!r.parked, dupKey: r.dup_key, fpKey: r.fp_key, createdAt: r.created_at, updatedAt: r.updated_at };
    if (!full) return base;
    return { ...base, doc: this.dec(org, 'doc', r.doc_enc), result: JSON.parse(this.dec(org, 'result', r.result_enc)), history: JSON.parse(this.dec(org, 'history', r.history_enc)) };
  }
  getInvoice(org, id) { return this.#inv(org, this.#p('SELECT * FROM invoices WHERE org_id = ? AND id = ?').get(org, id), true); }
  listInvoices(org, { status, owner, q, limit = 200, offset = 0 } = {}) {
    const where = ['org_id = ?'], args = [org];
    if (status) { where.push('status = ?'); args.push(status); }
    if (owner) { where.push('owner = ?'); args.push(owner); }
    if (q) { where.push("(invoice_number LIKE ? ESCAPE '\\' OR vendor_name LIKE ? ESCAPE '\\' OR po_number LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')"); const like = `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`; args.push(like, like, like, like); }
    const rows = this.#p(`SELECT * FROM invoices WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...args, Math.min(limit, 500), offset);
    return rows.map((r) => this.#inv(org, r, false));
  }
  countByStatus(org) {
    return Object.fromEntries(this.#p('SELECT status, COUNT(*) AS c FROM invoices WHERE org_id = ? GROUP BY status').all(org).map((r) => [r.status, r.c]));
  }
  countByOwner(org) {
    return Object.fromEntries(this.#p("SELECT owner, COUNT(*) AS c FROM invoices WHERE org_id = ? AND status IN ('APPROVAL_REQUIRED','PARKED','EXCEPTION','BLOCKED','REVIEW') GROUP BY owner").all(org).map((r) => [r.owner, r.c]));
  }
  findByKey(org, column, key) {
    if (!key) return undefined;
    const col = column === 'dup' ? 'dup_key' : 'fp_key';
    return this.#p(`SELECT id FROM invoices WHERE org_id = ? AND ${col} = ? LIMIT 1`).get(org, key)?.id;
  }
  /** Item quantities billed on a PO by other invoices that are paid, approved or waiting (they hold duplicate keys). */
  invoicedQty(org, po, excludeId) {
    const out = {};
    for (const r of this.#p('SELECT result_enc FROM invoices WHERE org_id = ? AND po_number = ? AND id != ? AND dup_key IS NOT NULL').all(org, po, excludeId || '')) {
      const res = JSON.parse(this.dec(org, 'result', r.result_enc));
      const po2 = res.invoice?.lines || [];
      for (const l of po2) out[l.sku] = (out[l.sku] || 0) + l.qty;
    }
    return out;
  }
  parkedOn(org, po) {
    return this.#p('SELECT * FROM invoices WHERE org_id = ? AND parked = 1 AND po_number = ? ORDER BY seq').all(org, po).map((r) => this.#inv(org, r, true));
  }

  // ---------- ledger ----------
  post(org, entry) {
    this.#p('INSERT OR REPLACE INTO ledger (org_id,invoice_id,entry_json,created_at) VALUES (?,?,?,?)').run(org, entry.id, JSON.stringify(entry), now());
  }
  ledgerEntry(org, invoiceId) { const r = this.#p('SELECT entry_json FROM ledger WHERE org_id = ? AND invoice_id = ?').get(org, invoiceId); return r && JSON.parse(r.entry_json); }
  /** Mark scheduled payments as handed to the bank, so the next payment file never repeats them. */
  markExported(org, entries, ts) {
    const st = this.#p('UPDATE ledger SET entry_json = ? WHERE org_id = ? AND invoice_id = ?');
    for (const e of entries) st.run(JSON.stringify({ ...e, exportedAt: ts }), org, e.id);
  }
  /** Remove a scheduled payment (used when a paid-automatically decision is disputed). */
  unpost(org, invoiceId) { this.#p('DELETE FROM ledger WHERE org_id = ? AND invoice_id = ?').run(org, invoiceId); }
  disputeCounts(org) {
    const n = (a) => this.#p('SELECT COUNT(*) AS n FROM audit WHERE org_id = ? AND action = ?').get(org, a).n;
    return { raised: n('invoice.disputed'), confirmed: n('invoice.dispute_confirmed'), corrected: n('invoice.dispute_corrected') };
  }
  ledger(org) { return this.#p('SELECT entry_json FROM ledger WHERE org_id = ? ORDER BY created_at DESC').all(org).map((r) => JSON.parse(r.entry_json)); }
  ledgerTotals(org) {
    const rows = this.ledger(org);
    return { count: rows.length, total: rows.reduce((s, e) => s + (e.total || 0), 0), discounts: rows.reduce((s, e) => s + ((e.total || 0) - (e.payAmount ?? e.total ?? 0)), 0) };
  }

  // ---------- audit: append-only, hash-chained ----------
  audit(org, actor, action, target, detail = {}) {
    return this.tx(() => {
      const last = this.#p('SELECT seq, hash FROM audit WHERE org_id = ? ORDER BY seq DESC LIMIT 1').get(org);
      const seq = (last?.seq || 0) + 1;
      const prev = last?.hash || 'GENESIS';
      const ts = now();
      // Details can hold names and notes, so they are encrypted too; the hash covers the ciphertext.
      const detailJson = this.enc(org, 'audit', JSON.stringify(detail));
      const hash = sha256(`${prev}|${org}|${seq}|${ts}|${actor}|${action}|${target ?? ''}|${detailJson}`);
      this.#p('INSERT INTO audit (org_id,seq,ts,actor,action,target,detail_json,prev_hash,hash) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(org, seq, ts, actor, action, target ?? null, detailJson, prev, hash);
      return { seq, hash };
    });
  }
  listAudit(org, { limit = 200, target, actor } = {}) {
    const rows = actor
      ? this.#p('SELECT * FROM audit WHERE org_id = ? AND actor = ? ORDER BY seq DESC LIMIT ?').all(org, actor, limit)
      : target
      ? this.#p('SELECT * FROM audit WHERE org_id = ? AND target = ? ORDER BY seq DESC LIMIT ?').all(org, target, limit)
      : this.#p('SELECT * FROM audit WHERE org_id = ? ORDER BY seq DESC LIMIT ?').all(org, limit);
    return rows.map((r) => {
      let detail = {};
      try { detail = JSON.parse(this.dec(org, 'audit', r.detail_json)); } catch { detail = { unreadable: true }; }
      return { seq: r.seq, ts: r.ts, actor: r.actor, action: r.action, target: r.target, detail, hash: r.hash };
    });
  }
  /** Recompute the whole chain. Any edited, deleted or reordered row breaks it. */
  verifyAudit(org) {
    let prev = 'GENESIS', n = 0;
    for (const r of this.#p('SELECT * FROM audit WHERE org_id = ? ORDER BY seq').iterate(org)) {
      n++;
      const h = sha256(`${prev}|${org}|${r.seq}|${r.ts}|${r.actor}|${r.action}|${r.target ?? ''}|${r.detail_json}`);
      if (r.seq !== n || r.prev_hash !== prev || r.hash !== h) return { ok: false, entries: n, brokenAt: r.seq };
      prev = h;
    }
    return { ok: true, entries: n };
  }
}

/** Adapter that lets the agent run against one workspace in the database. Writes are buffered
 *  and applied by the service inside a transaction after the agent finishes. */
export class SqlERP {
  constructor(store, org) {
    this.s = store;
    this.org = org;
    this.writes = { processed: null, posts: [], park: null, grns: [], release: [] };
  }
  approvalLimit() { return this.s.getOrg(this.org).approvalLimit; }
  policy() { return this.s.getOrg(this.org).settings; }
  findVendor({ sellerVat, sellerName }) {
    return (sellerVat && this.s.getVendor(this.org, sellerVat)) || (sellerName ? this.s.findVendorByName(this.org, sellerName) : undefined);
  }
  getPO(n) { return n ? this.s.getPO(this.org, n) : undefined; }
  getGRNs(po) { return this.s.getGRNs(this.org, po).concat(this.writes.grns.filter((g) => g.poNumber === po)); }
  addGRN(g) { this.writes.grns.push(g); }
  static keys(inv, vendor) {
    const vat = vendor?.vat || inv.sellerVat;
    return { dup: `${vat}|${inv.invoiceNumber}`, fp: `${vat}|${inv.poNumber}|${Number(inv.total).toFixed(2)}|${inv.issueDate}` };
  }
  duplicateOf(inv, vendor) {
    const k = SqlERP.keys(inv, vendor);
    return this.s.findByKey(this.org, 'dup', k.dup) || this.s.findByKey(this.org, 'fp', k.fp);
  }
  invoicedQty(po, excludeId) { return this.s.invoicedQty(this.org, po, excludeId); }
  markProcessed(id, inv, vendor) { this.writes.processed = { id, ...SqlERP.keys(inv, vendor) }; }
  post(entry) { this.writes.posts.push(entry); }
  park(id, doc, po) { this.writes.park = { id, po }; }
  parkedOn(po) { return this.s.parkedOn(this.org, po).map((r) => ({ id: r.id, doc: r.doc })); }
  release(id) { this.writes.release.push(id); }
}
