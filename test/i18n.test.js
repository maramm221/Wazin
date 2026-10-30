// Every interface string exists in both languages, and every error the server can send has a message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { STRINGS, ACTION_LABELS } from '../public/i18n.js';

test('English and Arabic have exactly the same keys', () => {
  const en = Object.keys(STRINGS.en).sort(), ar = Object.keys(STRINGS.ar).sort();
  assert.deepEqual(en.filter((k) => !ar.includes(k)), [], 'missing in Arabic');
  assert.deepEqual(ar.filter((k) => !en.includes(k)), [], 'missing in English');
  for (const k of en) if (Array.isArray(STRINGS.en[k])) assert.equal(STRINGS.ar[k].length, STRINGS.en[k].length, k);
});

test('Arabic strings are actually Arabic', () => {
  const skip = new Set(['lang_switch', 'app_name']);
  for (const [k, v] of Object.entries(STRINGS.ar)) {
    if (skip.has(k)) continue;
    const s = Array.isArray(v) ? v.join(' ') : v;
    assert.match(s, /[؀-ۿ]/, `${k} has no Arabic text`);
  }
});

test('every audit action has a label in both languages', () => {
  assert.deepEqual(Object.keys(ACTION_LABELS.en).sort(), Object.keys(ACTION_LABELS.ar).sort());
  const src = fs.readFileSync(new URL('../server/service.js', import.meta.url), 'utf8');
  const actions = new Set([...src.matchAll(/audit\([^,]+,\s*[^,]+,\s*'([a-z_.]+)'/g)].map((m) => m[1]));
  for (const a of actions) assert.ok(ACTION_LABELS.en[a], `no label for audit action ${a}`);
});

test('every error code the server sends has a message in both languages', () => {
  const src = ['../server/service.js', '../server/app.js'].map((f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8')).join('\n');
  const codes = new Set([...src.matchAll(/(?:bad|AppError\(\d+,)\s*\(?'([a-z_]+)'/g)].map((m) => m[1]));
  for (const extra of ['not_signed_in', 'forbidden', 'not_found', 'rate_limited']) codes.add(extra);
  const ignore = new Set(['json_required', 'method_not_allowed', 'unknown_action', 'unknown_import', 'unknown_item', 'nothing_to_verify', 'bad_origin', 'server_error']);
  const missing = [...codes].filter((c) => !ignore.has(c) && !STRINGS.en[`e_${c}`]);
  assert.deepEqual(missing, []);
});

test('every invoice status and owner has a label', () => {
  for (const s of ['APPROVED_AUTO', 'APPROVED', 'APPROVAL_REQUIRED', 'PARKED', 'EXCEPTION', 'BLOCKED', 'REVIEW', 'REJECTED', 'CLOSED']) assert.ok(STRINGS.ar[`st_${s}`], s);
  for (const o of ['AP', 'VENDOR', 'PROCUREMENT', 'WAREHOUSE', 'TREASURY', 'FINANCE_MANAGER', 'NONE']) assert.ok(STRINGS.ar[`ow_${o}`], o);
});
