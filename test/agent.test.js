import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERP } from '../src/erp.js';
import { WazinAgent } from '../src/agent.js';
import { threeWayMatch } from '../src/match.js';
import { encodeQR, round2 } from '../src/zatca.js';
import { renderUBL, renderText, renderEmail, VENDORS } from '../data/generate.js';

const V = VENDORS[0]; // Al-Noor: 2% / 10-day early-payment discount
const PO = { poNumber: 'PO-1', vendorVat: V.vat, buyer: 'sara@sahara.example', lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 10, unitPrice: 450 }, { sku: 'OFF-DSK', name: 'Standing desk', qty: 2, unitPrice: 1200 }] };
const GRN = { grnNumber: 'GRN-1', poNumber: 'PO-1', lines: [{ sku: 'OFF-CHR', qty: 10 }, { sku: 'OFF-DSK', qty: 2 }] };

function makeInvoice(over = {}) {
  const inv = { invoiceNumber: 'ALN-1', uuid: 'u', issueDate: '2026-10-05', issueTime: '10:00:00', sellerName: V.nameEn, sellerVat: V.vat, poNumber: 'PO-1', iban: V.iban,
    lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 10, unitPrice: 450 }, { sku: 'OFF-DSK', name: 'Standing desk', qty: 2, unitPrice: 1200 }], ...over };
  inv.subtotal ??= round2(inv.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  inv.vatAmount ??= round2(inv.subtotal * 0.15);
  inv.total ??= round2(inv.subtotal + inv.vatAmount);
  inv.qr ??= encodeQR({ sellerName: inv.sellerName, vatNumber: inv.sellerVat, timestamp: 't', total: inv.total.toFixed(2), vatTotal: inv.vatAmount.toFixed(2) });
  return inv;
}
const setup = ({ grns = [GRN], limit = 50000, llm } = {}) => new WazinAgent(new ERP({ vendors: VENDORS, purchaseOrders: [PO], goodsReceipts: grns, approvalLimit: limit }), { llm });

test('clean invoice: touchless approval, posted to ledger, discount captured', async () => {
  const agent = setup();
  const r = await agent.process(renderUBL(makeInvoice()));
  assert.equal(r.decision, 'APPROVED_AUTO');
  assert.deepEqual(r.reasonCodes, []);
  assert.equal(r.owner, 'NONE');
  assert.equal(r.message, undefined, 'no human message needed');
  assert.equal(agent.erp.ledger.length, 1);
  assert.equal(r.payment.discount, round2(7935 * 0.02));
  assert.equal(r.payment.payOn, '2026-10-15', 'pay on day 10 to take the 2% discount');
  assert.equal(r.payment.dueDate, '2026-11-04');
  assert.equal(r.usage.llmCalls, 0);
});

test('over the approval limit: all checks pass, routed for one-click sign-off, not posted yet', async () => {
  const agent = setup({ limit: 5000 });
  const r = await agent.process(renderUBL(makeInvoice()));
  assert.equal(r.decision, 'APPROVAL_REQUIRED');
  assert.equal(r.owner, 'FINANCE_MANAGER');
  assert.equal(agent.erp.ledger.length, 0);
  assert.match(r.message.bodyEn, /Approve/);
});

test('same invoice twice -> second is blocked; renumbered resubmission also blocked', async () => {
  const agent = setup();
  await agent.process(renderUBL(makeInvoice()));
  const r2 = await agent.process(renderUBL(makeInvoice()));
  assert.equal(r2.decision, 'BLOCKED');
  assert.deepEqual(r2.reasonCodes, ['DUPLICATE']);
  const r3 = await agent.process(renderText(makeInvoice({ invoiceNumber: 'ALN-1-COPY' }), V));
  assert.deepEqual(r3.reasonCodes, ['DUPLICATE']);
  assert.equal(agent.erp.ledger.length, 1, 'paid once');
});

test('bank account change -> payment held, treasury told to verify by phone on file', async () => {
  const r = await setup().process(renderUBL(makeInvoice({ iban: 'SA0000000000000000000001' })));
  assert.equal(r.decision, 'BLOCKED');
  assert.equal(r.owner, 'TREASURY');
  assert.deepEqual(r.reasonCodes, ['BANK_DETAILS_CHANGED']);
  assert.match(r.message.bodyEn, new RegExp(V.phone.replace(/\+/g, '\\+')));
});

test('non-compliant invoice -> supplier gets a bilingual correction request', async () => {
  const r = await setup().process(renderUBL(makeInvoice({ sellerVat: '110122334400003' })));
  assert.equal(r.decision, 'EXCEPTION');
  assert.equal(r.owner, 'VENDOR');
  assert.deepEqual(r.reasonCodes, ['INVALID_VAT_NUMBER']);
  assert.match(r.message.bodyAr, /هيئة الزكاة والضريبة والجمارك/);
  assert.equal(r.message.to, V.email);
});

test('price above PO -> procurement, with overcharge quantified', async () => {
  const inv = makeInvoice({ lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 10, unitPrice: 495 }, { sku: 'OFF-DSK', name: 'Standing desk', qty: 2, unitPrice: 1200 }] });
  const r = await setup().process(renderUBL(inv));
  assert.equal(r.owner, 'PROCUREMENT');
  assert.equal(r.issues.find((i) => i.code === 'PRICE_VARIANCE').overcharge, 450);
  assert.equal(r.message.to, PO.buyer);
});

test('price within 1% tolerance is accepted (rounding on supplier side)', async () => {
  const inv = makeInvoice({ lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 10, unitPrice: 452 }, { sku: 'OFF-DSK', name: 'Standing desk', qty: 2, unitPrice: 1200 }] });
  assert.equal((await setup().process(renderUBL(inv))).decision, 'APPROVED_AUTO');
});

test('billed more than received -> warehouse', async () => {
  const r = await setup({ grns: [{ ...GRN, lines: [{ sku: 'OFF-CHR', qty: 7 }, { sku: 'OFF-DSK', qty: 2 }] }] }).process(renderUBL(makeInvoice()));
  assert.equal(r.owner, 'WAREHOUSE');
  assert.deepEqual(r.reasonCodes, ['QTY_VARIANCE']);
});

test('partial deliveries across two GRNs add up', () => {
  const m = threeWayMatch(makeInvoice(), PO, [{ lines: [{ sku: 'OFF-CHR', qty: 6 }, { sku: 'OFF-DSK', qty: 2 }] }, { lines: [{ sku: 'OFF-CHR', qty: 4 }] }]);
  assert.deepEqual(m.issues, []);
});

test('item not on PO and over-ordered quantity are caught', () => {
  const inv = makeInvoice({ lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 12, unitPrice: 450 }, { sku: 'X', name: 'Gold pen', qty: 1, unitPrice: 999 }] });
  const codes = threeWayMatch(inv, PO, [GRN]).issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['ITEM_NOT_ON_PO', 'QTY_VARIANCE']);
});

test('no goods receipt yet -> parked, then auto-resumed and paid when GRN is posted', async () => {
  const agent = setup({ grns: [] });
  const r = await agent.process(renderUBL(makeInvoice()));
  assert.equal(r.decision, 'PARKED');
  assert.equal(agent.erp.parked.size, 1);
  const resumed = await agent.onGoodsReceipt(GRN);
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].decision, 'APPROVED_AUTO');
  assert.equal(resumed[0].id, r.id, 'same case id is kept through the hand-off');
  assert.equal(resumed[0].steps[0].key, 'resumed');
  assert.equal(agent.erp.parked.size, 0);
  assert.equal(agent.erp.ledger.length, 1);
});

test('unknown PO and unknown vendor are routed to procurement', async () => {
  assert.deepEqual((await setup().process(renderUBL(makeInvoice({ poNumber: 'PO-404' })))).reasonCodes, ['PO_NOT_FOUND']);
  const r = await setup().process(renderUBL(makeInvoice({ sellerName: 'Ghost Trading', sellerVat: '399999999999993' })));
  assert.ok(r.reasonCodes.includes('VENDOR_UNKNOWN'));
  assert.equal(r.owner, 'PROCUREMENT');
});

test('multiple simultaneous problems are ALL reported; the riskiest decides the route', async () => {
  const inv = makeInvoice({ iban: 'SA0000000000000000000001', sellerVat: '31012233440000', vatAmount: 100, lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 10, unitPrice: 500 }, { sku: 'OFF-DSK', name: 'Standing desk', qty: 2, unitPrice: 1200 }] });
  const r = await setup().process(renderUBL(inv));
  assert.deepEqual([...r.reasonCodes].sort(), ['BANK_DETAILS_CHANGED', 'INVALID_VAT_NUMBER', 'PRICE_VARIANCE', 'VAT_CALC_ERROR']);
  assert.equal(r.decision, 'BLOCKED');
  assert.equal(r.owner, 'TREASURY');
});

test('free-text invoice without LLM -> human data review; with LLM -> fully processed and still verified', async () => {
  const doc = renderEmail(makeInvoice());
  const r1 = await setup().process(doc);
  assert.equal(r1.decision, 'REVIEW');
  const inv = makeInvoice();
  const llm = async () => JSON.stringify({ ...inv, lines: inv.lines });
  const r2 = await setup({ llm }).process(doc);
  assert.equal(r2.decision, 'APPROVED_AUTO');
  assert.equal(r2.usage.llmCalls, 1);
  // An LLM that hallucinates the VAT is caught by the deterministic checks:
  const liar = async () => JSON.stringify({ ...inv, vatAmount: 500 });
  const r3 = await setup({ llm: liar }).process(renderEmail(makeInvoice()));
  assert.notEqual(r3.decision, 'REVIEW');
  assert.ok(r3.reasonCodes.includes('VAT_CALC_ERROR'));
});

test('every result carries an explainable audit trail', async () => {
  const r = await setup().process(renderUBL(makeInvoice()));
  assert.deepEqual(r.steps.map((s) => s.key), ['read', 'zatca', 'vendor', 'duplicate', 'match', 'post']);
  assert.ok(r.steps.every((s) => s.detailAr && s.nameAr), 'every step is explained in Arabic too');
  assert.ok(r.steps.every((s) => s.detail.length > 10));
  assert.ok(r.issues.every((i) => i.messageAr));
  assert.ok(r.ms >= 0);
});

test('billing goods that were already invoiced, under a new number AND a new date, is blocked', async () => {
  const agent = setup();
  assert.equal((await agent.process(renderUBL(makeInvoice()))).decision, 'APPROVED_AUTO');
  const again = await agent.process(renderUBL(makeInvoice({ invoiceNumber: 'ALN-NEW', issueDate: '2026-10-20' })));
  assert.equal(again.decision, 'BLOCKED');
  assert.deepEqual(again.reasonCodes, ['ALREADY_INVOICED']);
  assert.equal(agent.erp.ledger.length, 1, 'paid once');
});

test('a second, honest invoice for the rest of a split delivery is accepted', async () => {
  const agent = setup({ grns: [{ grnNumber: 'G1', poNumber: 'PO-1', lines: [{ sku: 'OFF-CHR', qty: 6 }] }] });
  const first = makeInvoice({ lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 6, unitPrice: 450 }] });
  assert.equal((await agent.process(renderUBL(first))).decision, 'APPROVED_AUTO');
  await agent.onGoodsReceipt({ grnNumber: 'G2', poNumber: 'PO-1', lines: [{ sku: 'OFF-CHR', qty: 4 }] });
  const second = makeInvoice({ invoiceNumber: 'ALN-2', issueDate: '2026-10-09', lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 4, unitPrice: 450 }] });
  assert.equal((await agent.process(renderUBL(second))).decision, 'APPROVED_AUTO');
  const third = makeInvoice({ invoiceNumber: 'ALN-3', issueDate: '2026-10-11', lines: [{ sku: 'OFF-CHR', name: 'Ergonomic office chair', qty: 1, unitPrice: 450 }] });
  const r = await agent.process(renderUBL(third));
  assert.ok(r.reasonCodes.includes('ALREADY_INVOICED') || r.reasonCodes.includes('QTY_VARIANCE'));
  assert.notEqual(r.decision, 'APPROVED_AUTO');
});
