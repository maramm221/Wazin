// SQLite database (Node's built-in node:sqlite). One file, WAL mode, foreign keys on.
// Every business table carries org_id: each company's data is isolated by its workspace.
// Sensitive columns (bank accounts, phone numbers, emails of suppliers, invoice documents and
// results) are stored encrypted with AES-256-GCM; see crypto.js.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE orgs (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL CHECK (kind IN ('workspace','sandbox')),
     approval_limit REAL NOT NULL DEFAULT 50000,
     created_at INTEGER NOT NULL,
     expires_at INTEGER
   );
   CREATE TABLE users (
     id TEXT PRIMARY KEY,
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     email TEXT NOT NULL,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('admin','ap','finance','procurement','warehouse','treasury')),
     pw_hash TEXT NOT NULL,
     failed_logins INTEGER NOT NULL DEFAULT 0,
     locked_until INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     UNIQUE (email)
   );
   CREATE INDEX users_org ON users(org_id);
   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     csrf TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL
   );
   CREATE INDEX sessions_user ON sessions(user_id);
   CREATE TABLE vendors (
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     vat TEXT NOT NULL,
     name_en TEXT NOT NULL,
     name_ar TEXT NOT NULL DEFAULT '',
     iban_enc TEXT NOT NULL,
     phone_enc TEXT,
     email_enc TEXT,
     terms_days INTEGER NOT NULL DEFAULT 30,
     discount_pct REAL NOT NULL DEFAULT 0,
     discount_days INTEGER NOT NULL DEFAULT 0,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (org_id, vat)
   );
   CREATE TABLE purchase_orders (
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     po_number TEXT NOT NULL,
     vendor_vat TEXT NOT NULL,
     buyer TEXT NOT NULL DEFAULT '',
     lines_json TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (org_id, po_number)
   );
   CREATE TABLE goods_receipts (
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     grn_number TEXT NOT NULL,
     po_number TEXT NOT NULL,
     lines_json TEXT NOT NULL,
     received_by TEXT,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (org_id, grn_number)
   );
   CREATE INDEX grn_po ON goods_receipts(org_id, po_number);
   CREATE TABLE invoices (
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     invoice_number TEXT,
     vendor_vat TEXT,
     vendor_name TEXT,
     po_number TEXT,
     total REAL,
     status TEXT NOT NULL,
     owner TEXT NOT NULL,
     source TEXT NOT NULL,
     doc_enc TEXT NOT NULL,
     result_enc TEXT NOT NULL,
     history_enc TEXT NOT NULL,
     dup_key TEXT,
     fp_key TEXT,
     parked INTEGER NOT NULL DEFAULT 0,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (org_id, id)
   );
   CREATE INDEX inv_status ON invoices(org_id, status);
   CREATE INDEX inv_owner ON invoices(org_id, owner);
   CREATE INDEX inv_dup ON invoices(org_id, dup_key);
   CREATE INDEX inv_fp ON invoices(org_id, fp_key);
   CREATE INDEX inv_parked ON invoices(org_id, parked, po_number);
   CREATE TABLE ledger (
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     invoice_id TEXT NOT NULL,
     entry_json TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (org_id, invoice_id)
   );
   CREATE TABLE audit (
     org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     ts INTEGER NOT NULL,
     actor TEXT NOT NULL,
     action TEXT NOT NULL,
     target TEXT,
     detail_json TEXT NOT NULL,
     prev_hash TEXT NOT NULL,
     hash TEXT NOT NULL,
     PRIMARY KEY (org_id, seq)
   );`,
  // 2: per-company working settings (team set-up, 2- or 3-way matching, tolerance, early payment).
  `ALTER TABLE orgs ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';`,
  // 3: support requests sent from the Help page. The sender's name, email and message are encrypted.
  `CREATE TABLE support_requests (
     ref TEXT PRIMARY KEY,
     org_id TEXT REFERENCES orgs(id) ON DELETE SET NULL,
     user_id TEXT,
     topic TEXT NOT NULL,
     contact_enc TEXT NOT NULL,
     message_enc TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'open',
     created_at INTEGER NOT NULL
   );`,
];

/** Open (or create) the SQLite database in WAL mode and run any pending migrations. */
export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
  const row = db.prepare('SELECT v FROM schema_version').get();
  let v = row ? row.v : 0;
  if (!row) db.prepare('INSERT INTO schema_version (v) VALUES (0)').run();
  for (; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.prepare('UPDATE schema_version SET v = ?').run(v + 1);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return db;
}

/** Run fn inside a transaction; nested calls join the outer one. */
export function tx(db, fn) {
  if (db.__inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.__inTx = true;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.__inTx = false;
  }
}
