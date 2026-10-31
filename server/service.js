// Business operations. HTTP-independent so it can be tested directly.
// Every operation takes the acting user, checks the role, writes the audit trail.
import crypto from 'node:crypto';
import { WazinAgent, ledgerEntry, OWNERS } from '../src/agent.js';
import { isValidSaudiVat, round2 } from '../src/zatca.js';
import { SqlERP } from './store.js';
import { hashPassword, verifyPassword, passwordProblem, randomToken, DUMMY_HASH } from './crypto.js';
import { buildDemo } from '../data/demo.js';
import { DEFAULT_SETTINGS } from './store.js';
import { parseCSV } from './csv.js';

const SEED_PEOPLE = {
  ap: ['ap@sahara.example', 'Reem Al-Qahtani'], finance: ['finance@sahara.example', 'Faisal Al-Harbi'], procurement: ['procurement@sahara.example', 'Sara Al-Otaibi'],
  warehouse: ['warehouse@sahara.example', 'Omar Al-Ghamdi'], treasury: ['treasury@sahara.example', 'Noura Al-Shehri'], admin: ['admin@sahara.example', 'Khalid Al-Dosari'],
};

/** An error with an HTTP status and a stable code that the web app translates (e_<code>). */
/** Validate company settings from the web app; anything unknown or out of range is refused. */
function cleanSettings(input, current) {
  if (!input || typeof input !== 'object') throw bad('invalid_settings');
  const out = { ...current, teams: { ...current.teams } };
  if (input.teams !== undefined) {
    if (typeof input.teams !== 'object' || input.teams === null) throw bad('invalid_settings');
    for (const k of Object.keys(out.teams)) if (input.teams[k] !== undefined) out.teams[k] = input.teams[k] === true;
  }
  if (input.matching !== undefined) {
    if (!['two', 'three'].includes(input.matching)) throw bad('invalid_settings');
    out.matching = input.matching;
  }
  if (input.priceTolerancePct !== undefined) {
    const v = Number(input.priceTolerancePct);
    if (!Number.isFinite(v) || v < 0 || v > 10) throw bad('invalid_settings');
    out.priceTolerancePct = v;
  }
  if (input.earlyPay !== undefined) out.earlyPay = input.earlyPay === true;
  if (out.matching === 'two') out.teams.warehouse = false; // no deliveries to record
  return out;
}

export class AppError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}
const bad = (code, detail) => new AppError(400, code, detail);
export const SUPPORT_TOPICS = ['technical', 'account', 'billing', 'zatca', 'security', 'feedback'];
const forbidden = () => new AppError(403, 'forbidden');
const notFound = () => new AppError(404, 'not_found');

/** The six roles. The administrator may do every step, so a one-person company works too. */
export const ROLES = ['admin', 'ap', 'finance', 'procurement', 'warehouse', 'treasury'];
export const ROLE_OWNER = { ap: ['AP', 'VENDOR'], finance: ['FINANCE_MANAGER'], procurement: ['PROCUREMENT'], warehouse: ['WAREHOUSE'], treasury: ['TREASURY'], admin: Object.keys(OWNERS) };
const OPEN = ['APPROVAL_REQUIRED', 'PARKED', 'EXCEPTION', 'BLOCKED', 'REVIEW', 'DISPUTED'];
// Decisions made by Wazin itself, which any team member can dispute.
const DISPUTABLE = ['APPROVED_AUTO', 'APPROVAL_REQUIRED', 'PARKED', 'EXCEPTION', 'BLOCKED'];
export const DISPUTE_KINDS = ['should_not_pay', 'should_pay', 'wrong_problem', 'wrong_team'];
const PAYABLE = ['APPROVED_AUTO', 'APPROVAL_REQUIRED'];
const FINAL = ['APPROVED_AUTO', 'APPROVED', 'REJECTED', 'CLOSED'];
const MAX_DOC = 512 * 1024;
const SESSION_TTL = 12 * 60 * 60 * 1000;
const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60 * 1000;

const can = (user, ...roles) => user.role === 'admin' || roles.includes(user.role);
const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const email = (v) => {
  const e = str(v, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw bad('invalid_email');
  return e;
};
const iban = (v) => {
  const s = str(v, 40).replace(/\s/g, '').toUpperCase();
  if (!/^SA\d{22}$/.test(s)) throw bad('invalid_iban');
  return s;
};

/** Serialise invoice processing per workspace so duplicate checks never race. */
class Mutex {
  constructor() { this.tails = new Map(); }
  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    this.tails.set(key, next.catch(() => {}));
    return next;
  }
}

export class Service {
  constructor(store, { llm, log } = {}) {
    this.s = store;
    this.llm = llm;
    this.log = log || (() => {});
    this.lock = new Mutex();
  }

  // ======================= accounts =======================
  signup({ company, name, email: em, password }) {
    const c = str(company, 120), n = str(name, 120);
    if (!c) throw bad('company_required');
    if (!n) throw bad('name_required');
    const e = email(em);
    const p = passwordProblem(password);
    if (p) throw bad(p);
    if (this.s.getUserByEmail(e)) throw new AppError(409, 'email_taken');
    return this.s.tx(() => {
      // A new company starts as a one-person set-up (every task to the owner); teams are added in Settings.
      const org = this.s.createOrg({ name: c, kind: 'workspace', settings: { ...DEFAULT_SETTINGS, teams: { finance: false, procurement: false, warehouse: false, treasury: false } } });
      const user = this.s.createUser({ orgId: org.id, email: e, name: n, role: 'admin', pwHash: hashPassword(password) });
      this.s.audit(org.id, e, 'workspace.created', org.id, { company: c });
      return this.#newSession(user);
    });
  }

  login({ email: em, password }) {
    const e = str(em, 254).toLowerCase();
    const user = this.s.getUserByEmail(e);
    if (!user) {
      verifyPassword(String(password || ''), DUMMY_HASH); // same work as a real check
      throw new AppError(401, 'bad_credentials');
    }
    if (user.lockedUntil > Date.now()) throw new AppError(423, 'account_locked', { until: user.lockedUntil });
    if (!verifyPassword(String(password || ''), user.pwHash)) {
      const failed = user.failedLogins + 1;
      this.s.setLoginState(user.id, failed >= LOCK_AFTER ? 0 : failed, failed >= LOCK_AFTER ? Date.now() + LOCK_MS : 0);
      this.s.audit(user.orgId, user.email, failed >= LOCK_AFTER ? 'login.locked' : 'login.failed', user.id, {});
      throw new AppError(401, 'bad_credentials');
    }
    this.s.setLoginState(user.id, 0, 0);
    this.s.audit(user.orgId, user.email, 'login', user.id, {});
    return this.#newSession(user);
  }

  #newSession(user) {
    const token = randomToken(32), csrf = randomToken(24);
    this.s.createSession(user.id, token, csrf, SESSION_TTL);
    return { token, csrf, user: this.publicUser(user) };
  }

  logout(token) { if (token) this.s.deleteSession(token); }

  /** Resolve a session cookie to {user, org, csrf}. */
  authenticate(token) {
    if (!token) return null;
    const sess = this.s.getSession(token);
    if (!sess) return null;
    const user = this.s.getUser(sess.userId);
    if (!user) return null;
    const org = this.s.getOrg(user.orgId);
    if (!org) return null;
    return { user, org, csrf: sess.csrf };
  }

  publicUser(u) { return { id: u.id, email: u.email, name: u.name, role: u.role }; }
  me(ctx) { return { user: this.publicUser(ctx.user), org: { name: ctx.org.name, kind: ctx.org.kind, approvalLimit: ctx.org.approvalLimit, settings: ctx.org.settings, expiresAt: ctx.org.expiresAt }, csrf: ctx.csrf, ai: !!this.llm }; }

  changePassword(ctx, { current, next }) {
    if (!verifyPassword(String(current || ''), ctx.user.pwHash)) throw new AppError(401, 'bad_credentials');
    const p = passwordProblem(next);
    if (p) throw bad(p);
    this.s.setPassword(ctx.user.id, hashPassword(next));
    this.s.audit(ctx.org.id, ctx.user.email, 'password.changed', ctx.user.id, {});
  }

  listUsers(ctx) {
    if (!can(ctx.user)) throw forbidden();
    return this.s.listUsers(ctx.org.id).map((u) => this.publicUser(u));
  }

  addUser(ctx, { name, email: em, role }) {
    if (!can(ctx.user)) throw forbidden();
    const n = str(name, 120), e = email(em);
    if (!n) throw bad('name_required');
    if (!ROLES.includes(role)) throw bad('invalid_role');
    if (this.s.getUserByEmail(e)) throw new AppError(409, 'email_taken');
    const temp = `${randomToken(9)}7a`; // meets the policy; shown once to the admin
    const u = this.s.createUser({ orgId: ctx.org.id, email: e, name: n, role, pwHash: hashPassword(temp) });
    this.s.audit(ctx.org.id, ctx.user.email, 'user.added', u.id, { email: e, role });
    return { user: this.publicUser(u), temporaryPassword: temp };
  }

  removeUser(ctx, id) {
    if (!can(ctx.user)) throw forbidden();
    if (id === ctx.user.id) throw bad('cannot_remove_self');
    if (!this.s.deleteUser(ctx.org.id, id)) throw notFound();
    this.s.audit(ctx.org.id, ctx.user.email, 'user.removed', id, {});
  }

  updateSettings(ctx, { name, approvalLimit, settings }) {
    if (!can(ctx.user)) throw forbidden();
    const patch = {};
    if (name !== undefined) { patch.name = str(name, 120); if (!patch.name) throw bad('company_required'); }
    if (approvalLimit !== undefined) {
      const v = Number(approvalLimit);
      if (!Number.isFinite(v) || v < 0 || v > 1e9) throw bad('invalid_amount');
      patch.approvalLimit = v;
    }
    if (settings !== undefined) patch.settings = cleanSettings(settings, ctx.org.settings);
    this.s.updateOrg(ctx.org.id, patch);
    this.s.audit(ctx.org.id, ctx.user.email, 'settings.updated', ctx.org.id, patch);
  }

  // ======================= seeded company =======================
  /** Create "Sahara Trading Co." with one account per team, its suppliers, orders, receipts and inbox.
   *  Idempotent: does nothing if the company already exists. Used for reviewers (WAZIN_SEED_PASSWORD). */
  async seedCompany({ password }) {
    const p = passwordProblem(password);
    if (p) throw bad(p);
    if (this.s.getUserByEmail(SEED_PEOPLE.ap[0])) return null;
    const data = buildDemo(1);
    const more = buildDemo(2); // orders for invoices that will arrive later
    const org = this.s.createOrg({ name: 'Sahara Trading Co.', kind: 'workspace', approvalLimit: data.approvalLimit });
    const users = {};
    const pw = hashPassword(password);
    this.s.tx(() => {
      for (const role of ROLES) users[role] = this.s.createUser({ orgId: org.id, email: SEED_PEOPLE[role][0], name: SEED_PEOPLE[role][1], role, pwHash: pw });
      for (const v of data.vendors) this.s.upsertVendor(org.id, v);
      for (const src of [data, more]) {
        for (const po of src.purchaseOrders) this.s.upsertPO(org.id, { ...po, lines: po.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: l.unitPrice })) });
        for (const g of src.goodsReceipts) this.s.addGRN(org.id, g, 'import');
      }
      this.s.audit(org.id, 'system', 'company.created', org.id, {});
    });
    for (const item of data.inbox) await this.processNew({ user: users.ap, org: this.s.getOrg(org.id) }, item.doc, 'e-invoicing');
    return org.id;
  }

  // ======================= invoices =======================
  async #run(org, id, doc) {
    const erp = new SqlERP(this.s, org.id);
    const agent = new WazinAgent(erp, { llm: this.llm });
    const r = await agent.process(doc, { id });
    return { r, erp };
  }

  #commit(org, rec, r, erp, actor, action, note) {
    const final = ['APPROVED_AUTO'].includes(r.decision);
    rec.result = r;
    rec.status = r.decision;
    rec.owner = r.owner;
    rec.dupKey = erp.writes.processed?.dup ?? null;
    rec.fpKey = erp.writes.processed?.fp ?? null;
    rec.parked = !!erp.writes.park;
    rec.history = [...(rec.history || []), { ts: Date.now(), actor, action, note: note || null, decision: r.decision }];
    this.s.tx(() => {
      this.s.saveInvoice(org.id, rec);
      for (const p of erp.writes.posts) this.s.post(org.id, p);
      this.s.audit(org.id, actor, action, rec.id, { decision: r.decision, owner: r.owner, reasons: r.reasonCodes, note: note || undefined });
      if (final) this.s.audit(org.id, 'wazin', 'invoice.paid_scheduled', rec.id, { amount: r.payment?.amount, payOn: r.payment?.payOn });
    });
    return rec;
  }

  async processNew(ctx, doc, source = 'upload') {
    if (!can(ctx.user, 'ap')) throw forbidden();
    const d = typeof doc === 'string' ? doc.trim() : '';
    if (!d) throw bad('empty_document');
    if (d.length > MAX_DOC) throw new AppError(413, 'document_too_large');
    return this.lock.run(ctx.org.id, async () => {
      const { id, seq } = this.s.nextInvoiceId(ctx.org.id);
      const { r, erp } = await this.#run(ctx.org, id, d);
      const rec = this.#commit(ctx.org, { id, seq, doc: d, source, history: [], createdAt: Date.now() }, r, erp, ctx.user.email, 'invoice.received');
      return this.view(ctx, rec.id);
    });
  }

  list(ctx, query) {
    const out = this.s.listInvoices(ctx.org.id, {
      status: OPEN.concat(FINAL).includes(query.status) ? query.status : undefined,
      owner: Object.keys(OWNERS).includes(query.owner) ? query.owner : undefined,
      q: str(query.q, 80) || undefined,
      limit: Math.max(1, Math.min(500, Number(query.limit) || 200)),
    });
    return out;
  }

  view(ctx, id) {
    const rec = this.s.getInvoice(ctx.org.id, String(id));
    if (!rec) throw notFound();
    const r = rec.result || {};
    const v = r.vendorVat ? this.s.getVendor(ctx.org.id, r.vendorVat) : null;
    const vendor = v && { nameEn: v.nameEn, nameAr: v.nameAr, phone: v.phone, ibanMasked: maskTail(v.iban) };
    const poNum = r.invoice?.poNumber;
    const poRaw = poNum ? this.s.getPO(ctx.org.id, poNum) : null;
    let po = null;
    if (poRaw) {
      const rec2 = {};
      for (const g of this.s.getGRNs(ctx.org.id, poRaw.poNumber)) for (const l of g.lines) rec2[l.sku] = (rec2[l.sku] || 0) + l.qty;
      po = { ...poRaw, lines: poRaw.lines.map((l) => ({ ...l, received: rec2[l.sku] || 0 })) };
    }
    return { ...rec, vendor, po, actions: this.actionsFor(ctx.user, rec), audit: this.s.listAudit(ctx.org.id, { target: rec.id, limit: 50 }).map((e) => ({ ...e, actorName: this.#names(ctx)[e.actor] || e.actor })) };
  }

  actionsFor(user, rec) {
    const a = [];
    const codes = rec.result?.reasonCodes || [];
    const mine = (o) => can(user) || (ROLE_OWNER[user.role] || []).includes(o);
    if (rec.status === 'APPROVAL_REQUIRED' && can(user, 'finance')) a.push('approve', 'reject');
    if (rec.status === 'BLOCKED' && rec.owner === 'TREASURY' && can(user, 'treasury')) a.push('verify_bank', 'reject');
    if (rec.status === 'BLOCKED' && rec.owner === 'AP' && mine('AP')) a.push('close');
    if (rec.status === 'EXCEPTION' && rec.owner === 'PROCUREMENT' && can(user, 'procurement')) {
      if (codes.includes('VENDOR_UNKNOWN')) a.push('add_vendor');
      else a.push('amend_po');
      a.push('reject');
    }
    if (rec.status === 'EXCEPTION' && rec.owner === 'VENDOR' && can(user, 'ap')) a.push('resubmit', 'reject');
    if (['PARKED'].includes(rec.status) || (rec.status === 'EXCEPTION' && rec.owner === 'WAREHOUSE')) {
      if (can(user, 'warehouse')) a.push('record_receipt');
      if (rec.status === 'EXCEPTION' && can(user, 'procurement')) a.push('reject');
    }
    if (rec.status === 'REVIEW' && can(user, 'ap')) a.push('manual_entry', 'resubmit', 'reject');
    // Disputes: anyone can challenge a decision Wazin made; the Finance Manager settles it.
    if (rec.status === 'DISPUTED' && can(user, 'finance')) {
      a.push('uphold');
      if (rec.result?.payment && this.s.getVendor(user.orgId, rec.result.vendorVat)) a.push('approve');
      a.push('reject');
    }
    if (DISPUTABLE.includes(rec.status)) a.push('dispute');
    return [...new Set(a)];
  }

  async act(ctx, id, action, body = {}) {
    return this.lock.run(ctx.org.id, async () => {
      const rec = this.s.getInvoice(ctx.org.id, String(id));
      if (!rec) throw notFound();
      if (!this.actionsFor(ctx.user, rec).includes(action)) throw forbidden();
      const who = ctx.user.email;
      const note = str(body.note, 500) || null;
      const org = ctx.org;
      const rerun = async (doc, act, n) => {
        const { r, erp } = await this.#run(org, rec.id, doc);
        rec.doc = doc;
        this.#commit(org, rec, r, erp, who, act, n);
      };

      // When a disputed decision is settled, record whether Wazin's original decision stood.
      const dispute = rec.status === 'DISPUTED' ? [...(rec.history || [])].reverse().find((e) => e.action === 'invoice.disputed') : null;
      const settle = (wazinRight) => dispute && this.s.audit(org.id, who, wazinRight ? 'invoice.dispute_confirmed' : 'invoice.dispute_corrected', rec.id, { from: dispute.from, kind: dispute.kind });

      switch (action) {
        case 'dispute': {
          const kind = DISPUTE_KINDS.includes(body.kind) ? body.kind : null;
          if (!kind) throw bad('dispute_kind_required');
          if (!note) throw bad('reason_required');
          const from = rec.status;
          this.s.tx(() => {
            if (from === 'APPROVED_AUTO') this.s.unpost(org.id, rec.id); // hold the scheduled payment
            Object.assign(rec, { status: 'DISPUTED', owner: 'FINANCE_MANAGER' });
            rec.history.push({ ts: Date.now(), actor: who, action: 'invoice.disputed', note, kind, from, decision: 'DISPUTED' });
            this.s.saveInvoice(org.id, rec);
            this.s.audit(org.id, who, 'invoice.disputed', rec.id, { from, kind, note });
          });
          break;
        }
        case 'uphold': {
          // Wazin's decision stands: check the invoice again with today's facts and act on the result.
          await rerun(rec.doc, 'invoice.dispute_upheld', note);
          settle(true);
          break;
        }
        case 'approve': {
          const r = rec.result;
          const vendor = this.s.getVendor(org.id, r.vendorVat);
          this.s.tx(() => {
            this.s.post(org.id, ledgerEntry(rec.id, r.invoice, vendor, r.payment, who));
            Object.assign(rec, { status: 'APPROVED', owner: 'NONE', parked: false });
            rec.history.push({ ts: Date.now(), actor: who, action: 'invoice.approved', note, decision: 'APPROVED' });
            this.s.saveInvoice(org.id, rec);
            this.s.audit(org.id, who, 'invoice.approved', rec.id, { amount: r.payment?.amount, payOn: r.payment?.payOn, note: note || undefined });
            settle(PAYABLE.includes(dispute?.from));
          });
          break;
        }
        case 'reject':
        case 'close': {
          if (action === 'reject' && !note) throw bad('reason_required');
          const status = action === 'reject' ? 'REJECTED' : 'CLOSED';
          this.s.tx(() => {
            Object.assign(rec, { status, owner: 'NONE', parked: false, dupKey: null, fpKey: null });
            rec.history.push({ ts: Date.now(), actor: who, action: `invoice.${status.toLowerCase()}`, note, decision: status });
            this.s.saveInvoice(org.id, rec);
            this.s.audit(org.id, who, `invoice.${status.toLowerCase()}`, rec.id, { note: note || undefined });
            settle(!PAYABLE.includes(dispute?.from));
          });
          break;
        }
        case 'verify_bank': {
          if (body.confirmCalled !== true) throw bad('confirm_call_required');
          if (!note) throw bad('reason_required');
          const r = rec.result;
          const vendor = this.s.getVendor(org.id, r.vendorVat);
          if (!vendor || !r.invoice.iban) throw bad('nothing_to_verify');
          const newIban = iban(r.invoice.iban);
          this.s.tx(() => {
            this.s.upsertVendor(org.id, { ...vendor, iban: newIban });
            this.s.audit(org.id, who, 'supplier.bank_changed', vendor.vat, { from: maskTail(vendor.iban), to: maskTail(newIban), note });
          });
          await rerun(rec.doc, 'invoice.rechecked_after_bank_verification', note);
          break;
        }
        case 'amend_po': {
          const inv = rec.result.invoice;
          const po = this.s.getPO(org.id, inv.poNumber) || { poNumber: inv.poNumber, vendorVat: rec.result.vendorVat || inv.sellerVat, buyer: who, lines: [] };
          const lines = po.lines.map((l) => ({ ...l }));
          for (const il of inv.lines) {
            const pl = lines.find((x) => (il.sku && x.sku === il.sku) || x.name.toLowerCase() === String(il.name).toLowerCase());
            if (pl) { pl.unitPrice = il.unitPrice; pl.qty = Math.max(pl.qty, il.qty); } else lines.push({ sku: il.sku || il.name, name: il.name, qty: il.qty, unitPrice: il.unitPrice });
          }
          this.s.tx(() => {
            this.s.upsertPO(org.id, { ...po, lines });
            this.s.audit(org.id, who, po.lines.length ? 'po.amended' : 'po.created', po.poNumber, { invoice: rec.id, note: note || undefined });
          });
          await rerun(rec.doc, 'invoice.rechecked_after_po_change', note);
          break;
        }
        case 'add_vendor': {
          const inv = rec.result.invoice;
          if (!isValidSaudiVat(inv.sellerVat)) throw bad('invalid_vat');
          const v = { vat: inv.sellerVat, nameEn: str(body.nameEn, 120) || inv.sellerName, nameAr: str(body.nameAr, 120), iban: iban(body.iban || inv.iban), phone: str(body.phone, 40), email: str(body.email, 254), paymentTermsDays: 30 };
          if (!v.phone) throw bad('phone_required');
          this.s.tx(() => {
            this.s.upsertVendor(org.id, v);
            this.s.audit(org.id, who, 'supplier.added', v.vat, { name: v.nameEn, note: note || undefined });
          });
          await rerun(rec.doc, 'invoice.rechecked_after_supplier_added', note);
          break;
        }
        case 'record_receipt':
          return this.recordReceipt(ctx, { poNumber: rec.result.invoice.poNumber, lines: body.lines, note }, true).then(() => this.view(ctx, rec.id));
        case 'resubmit': {
          const doc = typeof body.doc === 'string' ? body.doc.trim() : '';
          if (!doc) throw bad('empty_document');
          if (doc.length > MAX_DOC) throw new AppError(413, 'document_too_large');
          await rerun(doc, 'invoice.resubmitted', note);
          break;
        }
        case 'manual_entry': {
          await rerun(buildManualDoc(body), 'invoice.entered_manually', note);
          break;
        }
        default:
          throw bad('unknown_action');
      }
      return this.view(ctx, rec.id);
    });
  }

  // ======================= purchase orders & goods receipts =======================
  listPOs(ctx) {
    return this.s.listPOs(ctx.org.id).map((p) => {
      const grns = this.s.getGRNs(ctx.org.id, p.poNumber);
      const received = {};
      for (const g of grns) for (const l of g.lines) received[l.sku] = (received[l.sku] || 0) + l.qty;
      return { ...p, grns, lines: p.lines.map((l) => ({ ...l, received: received[l.sku] || 0 })), total: round2(p.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0)) };
    });
  }

  async recordReceipt(ctx, { poNumber, lines, note }, locked = false) {
    if (!can(ctx.user, 'warehouse')) throw forbidden();
    const po = this.s.getPO(ctx.org.id, str(poNumber, 60));
    if (!po) throw bad('po_not_found');
    if (!Array.isArray(lines) || !lines.length) throw bad('lines_required');
    const clean = [];
    for (const l of lines) {
      const pl = po.lines.find((x) => x.sku === l.sku);
      const qty = Number(l.qty);
      if (!pl) throw bad('unknown_item', { sku: l.sku });
      if (!Number.isInteger(qty) || qty < 0 || qty > 1e6) throw bad('invalid_quantity', { sku: l.sku });
      if (qty > 0) clean.push({ sku: pl.sku, qty });
    }
    if (!clean.length) throw bad('lines_required');
    const work = async () => {
      const grn = { grnNumber: this.s.nextGrnNumber(ctx.org.id), poNumber: po.poNumber, lines: clean };
      this.s.tx(() => {
        this.s.addGRN(ctx.org.id, grn, ctx.user.email);
        this.s.audit(ctx.org.id, ctx.user.email, 'goods.received', po.poNumber, { grn: grn.grnNumber, lines: clean, note: str(note, 500) || undefined });
      });
      // Re-check every open invoice on this PO that was waiting on the warehouse.
      const waiting = this.s.listInvoices(ctx.org.id, { limit: 500 }).filter((i) => i.poNumber === po.poNumber && (i.status === 'PARKED' || (i.status === 'EXCEPTION' && i.owner === 'WAREHOUSE')));
      const resumed = [];
      for (const w of waiting) {
        const rec = this.s.getInvoice(ctx.org.id, w.id);
        const { r, erp } = await this.#run(ctx.org, rec.id, rec.doc);
        r.steps.unshift({ key: 'resumed', name: 'Resumed automatically', nameAr: 'استؤنفت تلقائياً', status: 'ok',
          detail: `Goods receipt ${grn.grnNumber} was recorded for ${po.poNumber}, so Wazin checked the invoice again.`,
          detailAr: `سُجّل سند الاستلام ${grn.grnNumber} لأمر الشراء ${po.poNumber}، فأعاد وازِن فحص الفاتورة.` });
        this.#commit(ctx.org, rec, r, erp, 'wazin', 'invoice.resumed_after_goods_receipt', grn.grnNumber);
        resumed.push({ id: rec.id, status: r.decision });
      }
      return { grn, resumed };
    };
    return locked ? work() : this.lock.run(ctx.org.id, work);
  }

  // ======================= suppliers =======================
  listVendors(ctx) {
    const reveal = can(ctx.user, 'treasury');
    return this.s.listVendors(ctx.org.id).map((v) => ({ ...v, iban: reveal ? v.iban : maskTail(v.iban), phone: v.phone, email: v.email }));
  }

  saveVendor(ctx, body) {
    if (!can(ctx.user, 'treasury', 'procurement')) throw forbidden();
    const vat = str(body.vat, 15);
    if (!isValidSaudiVat(vat)) throw bad('invalid_vat');
    const existing = this.s.getVendor(ctx.org.id, vat);
    const nameEn = str(body.nameEn, 120);
    if (!nameEn) throw bad('name_required');
    // Only treasury (or admin) may set or change bank details.
    let ib = existing?.iban;
    if (body.iban !== undefined && body.iban !== '' && (!existing || iban(body.iban) !== existing.iban)) {
      if (!can(ctx.user, 'treasury')) throw new AppError(403, 'treasury_only_bank');
      ib = iban(body.iban);
    }
    if (!ib) throw bad('invalid_iban');
    const pct = Number(body.discountPct || 0), days = Number(body.discountDays || 0), terms = Number(body.paymentTermsDays || 30);
    if (!(pct >= 0 && pct <= 20) || !Number.isInteger(days) || days < 0 || days > 365 || !Number.isInteger(terms) || terms < 0 || terms > 365) throw bad('invalid_terms');
    const v = { vat, nameEn, nameAr: str(body.nameAr, 120), iban: ib, phone: str(body.phone, 40), email: str(body.email, 254), paymentTermsDays: terms, earlyPayDiscount: pct > 0 ? { pct, days } : null };
    this.s.tx(() => {
      this.s.upsertVendor(ctx.org.id, v);
      this.s.audit(ctx.org.id, ctx.user.email, existing ? 'supplier.updated' : 'supplier.added', vat, { name: nameEn, bankChanged: existing ? existing.iban !== ib : undefined });
    });
    return this.listVendors(ctx).find((x) => x.vat === vat);
  }

  // ======================= imports (CSV) =======================
  importCSV(ctx, kind, text) {
    if (!can(ctx.user)) throw forbidden();
    if (typeof text !== 'string' || !text.trim()) throw bad('empty_file');
    if (text.length > 2 * 1024 * 1024) throw new AppError(413, 'document_too_large');
    const rows = parseCSV(text);
    const errors = [];
    let imported = 0;
    const need = { vendors: ['vat', 'name_en', 'iban'], purchase_orders: ['po_number', 'vendor_vat', 'sku', 'item_name', 'qty', 'unit_price'], goods_receipts: ['grn_number', 'po_number', 'sku', 'qty'] }[kind];
    if (!need) throw bad('unknown_import');
    const missing = need.filter((h) => !(h in (rows[0] || {})));
    if (missing.length) throw bad('missing_columns', { missing });
    this.s.tx(() => {
      if (kind === 'vendors') {
        rows.forEach((r, i) => {
          try {
            if (!isValidSaudiVat(r.vat)) throw bad('invalid_vat');
            this.s.upsertVendor(ctx.org.id, { vat: r.vat, nameEn: r.name_en, nameAr: r.name_ar || '', iban: iban(r.iban), phone: r.phone || '', email: r.email || '', paymentTermsDays: Number(r.payment_terms_days || 30), earlyPayDiscount: Number(r.discount_pct) > 0 ? { pct: Number(r.discount_pct), days: Number(r.discount_days || 0) } : null });
            imported++;
          } catch (e) { errors.push({ row: i + 2, error: e.code || 'invalid_row' }); }
        });
      } else if (kind === 'purchase_orders') {
        const byPo = new Map();
        rows.forEach((r, i) => {
          const qty = Number(r.qty), price = Number(r.unit_price);
          if (!r.po_number || !isValidSaudiVat(r.vendor_vat) || !r.sku || !(qty > 0) || !(price >= 0)) { errors.push({ row: i + 2, error: 'invalid_row' }); return; }
          const po = byPo.get(r.po_number) || { poNumber: r.po_number, vendorVat: r.vendor_vat, buyer: r.buyer || '', lines: [] };
          po.lines.push({ sku: r.sku, name: r.item_name, qty, unitPrice: price });
          byPo.set(r.po_number, po);
        });
        for (const po of byPo.values()) { this.s.upsertPO(ctx.org.id, po); imported++; }
      } else {
        const byGrn = new Map();
        rows.forEach((r, i) => {
          const qty = Number(r.qty);
          if (!r.grn_number || !r.po_number || !r.sku || !Number.isInteger(qty) || qty < 0) { errors.push({ row: i + 2, error: 'invalid_row' }); return; }
          const g = byGrn.get(r.grn_number) || { grnNumber: r.grn_number, poNumber: r.po_number, lines: [] };
          g.lines.push({ sku: r.sku, qty });
          byGrn.set(r.grn_number, g);
        });
        for (const g of byGrn.values()) {
          if (this.s.grnExists(ctx.org.id, g.grnNumber)) { errors.push({ grn: g.grnNumber, error: 'already_exists' }); continue; }
          this.s.addGRN(ctx.org.id, g, ctx.user.email); imported++;
        }
      }
      this.s.audit(ctx.org.id, ctx.user.email, `import.${kind}`, null, { imported, errors: errors.length });
    });
    return { imported, errors: errors.slice(0, 100) };
  }

  // ======================= dashboard & audit =======================
  dashboard(ctx) {
    const byStatus = this.s.countByStatus(ctx.org.id);
    const byOwner = this.s.countByOwner(ctx.org.id);
    const all = this.s.listInvoices(ctx.org.id, { limit: 500 });
    let stopped = 0;
    for (const i of all) {
      if (['BLOCKED', 'REJECTED'].includes(i.status) && i.total) stopped += i.total;
    }
    const mineOwners = ROLE_OWNER[ctx.user.role] || [];
    const myTasks = ctx.user.role === 'admin' ? all.filter((i) => OPEN.includes(i.status)) : all.filter((i) => OPEN.includes(i.status) && mineOwners.includes(i.owner) && (i.status !== 'PARKED' || ctx.user.role === 'warehouse'));
    const led = this.s.ledgerTotals(ctx.org.id);
    return {
      byStatus, byOwner, total: all.length,
      paidAutomatically: byStatus.APPROVED_AUTO || 0,
      paidAfterApproval: byStatus.APPROVED || 0,
      waiting: OPEN.reduce((s, k) => s + (byStatus[k] || 0), 0),
      stoppedAmount: round2(stopped),
      discounts: round2(led.discounts),
      // Real-world accuracy signal: how often people disputed a decision, and how often Wazin turned out right.
      disputes: { open: byStatus.DISPUTED || 0, ...this.s.disputeCounts(ctx.org.id) },
      myTasks: myTasks.slice(0, 50),
    };
  }

  #names(ctx) {
    const m = { wazin: 'Wazin', system: 'Wazin' };
    for (const u of this.s.listUsers(ctx.org.id)) m[u.email] = u.name;
    return m;
  }
  // ======================= my profile =======================
  /**
   * A request from the Help page. Signed-in users are identified by their session;
   * visitors give a name and email. Returns a reference number the user can quote.
   */
  submitSupport(ctx, { name, email: em, topic, message }) {
    const tp = SUPPORT_TOPICS.includes(topic) ? topic : null;
    if (!tp) throw bad('topic_required');
    const msg = str(message, 2000);
    if (msg.length < 10) throw bad('message_too_short');
    const who = ctx ? { name: ctx.user.name, email: ctx.user.email } : { name: str(name, 120), email: email(em) };
    if (!who.name) throw bad('name_required');
    const d = new Date();
    const ref = `WZ-${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    this.s.addSupportRequest({ ref, orgId: ctx?.org.id, userId: ctx?.user.id, topic: tp, ...who, message: msg });
    if (ctx) this.s.audit(ctx.org.id, ctx.user.email, 'support.requested', ref, { topic: tp });
    this.log('info', 'support_request', { ref, topic: tp, org: ctx?.org.id });
    return { ref, email: who.email, urgent: tp === 'security' };
  }

  updateProfile(ctx, { name }) {
    const n = str(name, 120);
    if (!n) throw bad('name_required');
    this.s.setName(ctx.user.id, n);
    this.s.audit(ctx.org.id, ctx.user.email, 'profile.updated', ctx.user.id, {});
  }

  /** What the signed-in person needs about their own account: their open tasks, their recent actions,
   *  when they last signed in, failed attempts since then, and how many devices are signed in. */
  myActivity(ctx) {
    const mine = this.s.listAudit(ctx.org.id, { actor: ctx.user.email, limit: 300 });
    const logins = mine.filter((e) => e.action === 'login');
    const previous = logins[1]?.ts ?? null; // [0] is this session's sign-in
    const failed = mine.filter((e) => e.action === 'login.failed' && (!logins[0] || e.ts > (previous ?? 0)) && e.ts < (logins[0]?.ts ?? Infinity)).length;
    const work = mine.filter((e) => !e.action.startsWith('login'));
    const since = Date.now() - 30 * 24 * 3600e3;
    return {
      openTasks: this.dashboard(ctx).myTasks.length,
      actions30d: work.filter((e) => e.ts >= since).length,
      previousSignIn: previous,
      failedSincePrevious: failed,
      devices: this.s.countSessions(ctx.user.id),
      recent: work.slice(0, 12).map((e) => ({ ts: e.ts, action: e.action, target: e.target })),
    };
  }

  signOutOtherDevices(ctx) {
    const n = this.s.deleteOtherSessions(ctx.user.id, ctx.token);
    this.s.audit(ctx.org.id, ctx.user.email, 'sessions.revoked', ctx.user.id, { count: n });
    return { signedOut: n };
  }

  auditLog(ctx) {
    const names = this.#names(ctx);
    const entries = this.s.listAudit(ctx.org.id, { limit: 300 }).map((e) => ({ ...e, actorName: names[e.actor] || e.actor }));
    return { entries, integrity: this.s.verifyAudit(ctx.org.id) };
  }
}

export const maskTail = (s) => (s ? `•••• ${String(s).slice(-4)}` : '');

/** Build a labelled-text invoice from a manual entry form so it runs through the normal checks. */
export function buildManualDoc(b) {
  const f = (k, max = 120) => str(b?.[k], max).replace(/[\r\n|]/g, ' ');
  const lines = Array.isArray(b?.lines) ? b.lines.slice(0, 100) : [];
  if (!f('invoiceNumber') || !f('issueDate') || !f('sellerName') || !f('sellerVat') || !f('poNumber') || !lines.length) throw bad('missing_fields');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f('issueDate'))) throw bad('invalid_date');
  const nums = ['subtotal', 'vatAmount', 'total'].map((k) => Number(b[k]));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) throw bad('invalid_amount');
  const itemRows = lines.map((l) => {
    const q = Number(l.qty), p = Number(l.unitPrice);
    if (!(q > 0) || !(p >= 0)) throw bad('invalid_amount');
    return `- ${str(l.sku, 60).replace(/[|\n]/g, ' ') || '-'} | ${str(l.name, 120).replace(/[|\n]/g, ' ')} | ${q} x ${p.toFixed(2)}`;
  });
  return [
    'TAX INVOICE / فاتورة ضريبية',
    `Invoice No / رقم الفاتورة: ${f('invoiceNumber')}`,
    `Date / التاريخ: ${f('issueDate')}`,
    `Seller / المورد: ${f('sellerName')}`,
    `Seller VAT / الرقم الضريبي: ${f('sellerVat', 20)}`,
    `PO / أمر الشراء: ${f('poNumber')}`,
    f('iban', 40) ? `IBAN: ${f('iban', 40)}` : '',
    'Items / البنود:',
    ...itemRows,
    `Subtotal / المجموع: ${nums[0].toFixed(2)}`,
    `VAT 15% / ضريبة القيمة المضافة: ${nums[1].toFixed(2)}`,
    `Total / الإجمالي: ${nums[2].toFixed(2)} SAR`,
    f('qr', 600) ? `QR: ${f('qr', 600)}` : '',
  ].filter(Boolean).join('\n');
}
