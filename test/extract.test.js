import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extract, parseUBL, parseText, normalizeDigits, toNumber, missingFields, parseLLMJson, detectFormat } from '../src/extract.js';
import { renderUBL, renderText, renderArabic, renderEmail, VENDORS } from '../data/generate.js';
import { encodeQR } from '../src/zatca.js';

const vendor = VENDORS[5]; // has "&" in its name -> exercises XML escaping
const inv = {
  invoiceNumber: 'HEJ-1001', uuid: 'u1', issueDate: '2026-10-12', issueTime: '09:30:00', sellerName: vendor.nameEn, sellerVat: vendor.vat,
  poNumber: 'PO-2026-1001', iban: vendor.iban,
  lines: [{ sku: 'FAC-CLN', name: 'Office cleaning (monthly)', nameAr: 'تنظيف مكاتب شهري', qty: 1, unitPrice: 6800 }, { sku: 'FAC-AC', name: 'AC maintenance visit', nameAr: 'صيانة تكييف', qty: 4, unitPrice: 350 }],
  subtotal: 8200, vatAmount: 1230, total: 9430,
};
inv.qr = encodeQR({ sellerName: inv.sellerName, vatNumber: inv.sellerVat, timestamp: '2026-10-12T09:30:00', total: '9430.00', vatTotal: '1230.00' });

const core = (x) => ({ invoiceNumber: x.invoiceNumber, issueDate: x.issueDate, sellerVat: x.sellerVat, poNumber: x.poNumber, iban: x.iban, subtotal: x.subtotal, vatAmount: x.vatAmount, total: x.total, qr: x.qr, lines: x.lines.map((l) => ({ sku: l.sku, qty: l.qty, unitPrice: l.unitPrice })) });

test('Tier 1: ZATCA UBL 2.1 XML parses exactly, with 0 LLM calls', async () => {
  const r = await extract(renderUBL(inv));
  assert.equal(r.format, 'ubl');
  assert.equal(r.usage.tier, 1);
  assert.equal(r.usage.llmCalls, 0);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(core(r.invoice), core(inv));
  assert.equal(r.invoice.sellerName, 'Hejaz Cleaning & Facilities', 'XML entities unescaped');
});

test('Tier 2: bilingual labelled text parses exactly', async () => {
  const r = await extract(renderText(inv, vendor));
  assert.equal(r.usage.tier, 2);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(core(r.invoice), core(inv));
});

test('Tier 2: Arabic-only invoice with Arabic-Indic digits parses exactly', async () => {
  const doc = renderArabic(inv, vendor);
  assert.match(doc, /٨٢٠٠٫٠٠/, 'fixture really uses Arabic digits');
  const r = await extract(doc);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(core(r.invoice), core(inv));
  assert.equal(r.invoice.sellerName, vendor.nameAr);
});

test('digit normalization', () => {
  assert.equal(normalizeDigits('٣١٠١٢٢'), '310122');
  assert.equal(normalizeDigits('۱۲۳'), '123');
  assert.equal(toNumber('١٬٢٣٤٫٥٠ ر.س'), 1234.5);
  assert.equal(toNumber('5,175.00 SAR'), 5175);
});

test('free-text email is NOT guessed by regex — it is escalated', async () => {
  const r = await extract(renderEmail(inv));
  assert.ok(r.missing.length > 0);
  assert.equal(r.usage.llmCalls, 0, 'no LLM configured -> no call');
});

test('Tier 3: LLM fills gaps from free text, called exactly once', async () => {
  let calls = 0;
  const fakeLLM = async (prompt) => {
    calls++;
    assert.match(prompt, /JSON only/);
    assert.match(prompt, /HEJ-1001/);
    return 'Sure! ```json\n' + JSON.stringify({ invoiceNumber: 'HEJ-1001', issueDate: '2026-10-12', sellerName: vendor.nameEn, sellerVat: vendor.vat.replace(/(\d{4})/g, '$1 '), poNumber: 'PO-2026-1001', iban: vendor.iban, lines: [{ sku: 'FAC-CLN', name: 'Office cleaning (monthly)', qty: 1, unitPrice: '6,800.00' }, { sku: 'FAC-AC', name: 'AC maintenance visit', qty: 4, unitPrice: 350 }], subtotal: 8200, vatAmount: 1230, total: 9430, qr: inv.qr }) + '\n```';
  };
  const r = await extract(renderEmail(inv), { llm: fakeLLM });
  assert.equal(calls, 1);
  assert.equal(r.usage.tier, 3);
  assert.deepEqual(r.missing, []);
  assert.equal(r.invoice.sellerVat, vendor.vat, 'spaces stripped');
  assert.equal(r.invoice.lines[0].unitPrice, 6800);
  assert.ok(r.usage.llmTokens > 0);
});

test('Tier 3: a broken LLM reply degrades to human review, never crashes', async () => {
  const r = await extract(renderEmail(inv), { llm: async () => 'I cannot help with that' });
  assert.ok(r.missing.length > 0);
  assert.match(r.usage.llmError, /no JSON/);
  const r2 = await extract(renderEmail(inv), { llm: async () => { throw new Error('timeout'); } });
  assert.equal(r2.usage.llmError, 'timeout');
});

test('LLM is not called when deterministic tiers already succeed', async () => {
  let calls = 0;
  await extract(renderUBL(inv), { llm: async () => { calls++; return '{}'; } });
  await extract(renderText(inv, vendor), { llm: async () => { calls++; return '{}'; } });
  assert.equal(calls, 0);
});

test('helpers', () => {
  assert.equal(detectFormat('  <?xml version="1.0"?><Invoice xmlns="x">'), 'ubl');
  assert.equal(detectFormat('Invoice No: 1'), 'text');
  assert.deepEqual(missingFields({}).length, 9);
  assert.throws(() => parseLLMJson('nothing'), /no JSON/);
  assert.equal(parseUBL('<Invoice></Invoice>').lines.length, 0);
  assert.equal(parseText('').lines.length, 0);
});

// Regression guards from the held-out study (eval/heldout.js): messy but valid documents read the same.
test('messy text invoices read the same: CRLF, indentation, Arabic-Indic digits, shuffled header, lower-case labels', async () => {
  const want = core((await extract(renderText(inv, vendor))).invoice);
  const AR = '٠١٢٣٤٥٦٧٨٩';
  const ls = renderText(inv, vendor).split('\n');
  const end = ls.findIndex((l) => l.startsWith('Items'));
  const variants = [
    renderText(inv, vendor).replace(/\n/g, '\r\n'),
    renderText(inv, vendor).split('\n').map((l) => `   ${l}  `).join('\n\n'),
    renderText(inv, vendor).replace(/\d/g, (x) => AR[x]),
    [ls[0], ...ls.slice(1, end).reverse(), ...ls.slice(end)].join('\n'),
    ls.map((l) => (l.includes(':') && !l.startsWith('QR') ? l.slice(0, l.indexOf(':')).toLowerCase() + l.slice(l.indexOf(':')) : l)).join('\n'),
  ];
  for (const v of variants) assert.deepEqual(core((await extract(v)).invoice), want);
});

test('minified ZATCA XML reads the same as the formatted file', async () => {
  const pretty = await extract(renderUBL(inv));
  const mini = await extract(renderUBL(inv).replace(/>\s+</g, '><').trim());
  assert.deepEqual(core(mini.invoice), core(pretty.invoice));
  assert.equal(mini.usage.llmCalls, 0);
});
