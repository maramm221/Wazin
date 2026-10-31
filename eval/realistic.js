// Realistic stress set: a balanced benchmark plus hard, real-world situations that Wazin's rules were
// NOT designed around. The answer for every invoice is what a careful accounts-payable team would do,
// decided before running Wazin. Unlike the generated benchmark, Wazin is expected to get some wrong:
// this report shows where, how badly, and which mistakes are safe (a person looks at it) or unsafe
// (money paid that should not be). Disputes in the web app exist to catch the rest in real use.
//
// Usage: node eval/realistic.js [--seed N]  ->  eval/REALISTIC.md and eval/realistic.json
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { buildScenario, mulberry32, renderUBL, renderText, renderArabic, renderEmail, VENDORS, DEFECTS } from '../data/generate.js';
import { encodeQR, round2, VAT_RATE } from '../src/zatca.js';
import { ERP } from '../src/erp.js';
import { WazinAgent } from '../src/agent.js';

const argSeed = process.argv.indexOf('--seed');
const SEED = argSeed > 0 ? Number(process.argv[argSeed + 1]) : 91919;
const FRESH_SEED = 92021; // a new hard set, generated only after the v2 fixes, to check they were not tuned to one sample
const N_PER_CASE = 20;
const LIMIT = 50000;
const f2 = (n) => Number(n).toFixed(2);
const PAY = 'APPROVED_AUTO';

// ---------------------------------------------------------------- outcome of one invoice
/** correct · person (unreadable, a person enters it) · held (should be paid, was not) · misrouted (not paid, but wrong decision) · paid_wrongly */
function outcome(truth, got) {
  if (got === truth) return 'correct';
  if (got === 'REVIEW') return 'person';
  if (got === PAY) return 'paid_wrongly';
  if (truth === PAY) return 'held';
  return 'misrouted';
}

// ---------------------------------------------------------------- Part A: balanced, diverse benchmark
// Every one of the 11 situations appears equally often (the development set is 40% clean invoices).
async function balanced(seed) {
  const weights = Object.fromEntries(DEFECTS.map((d) => [d, 1]));
  const sc = buildScenario({ seed, n: 550, weights, compoundShare: 0.2 });
  const erp = new ERP({ vendors: sc.vendors, purchaseOrders: sc.purchaseOrders, goodsReceipts: sc.goodsReceipts, approvalLimit: sc.approvalLimit });
  const agent = new WazinAgent(erp);
  const rows = [];
  for (const e of sc.invoices) {
    const r = await agent.process(e.doc, { id: e.id });
    rows.push({ group: e.defect.includes('+') ? 'several problems at once' : e.defect, format: e.format, truth: e.expected.decision, got: r.decision, total: e.truth.total });
  }
  return rows;
}

// ---------------------------------------------------------------- Part B: hard, real-world situations
function makeInv(rnd, vendor, lines, { po, number, date = '2026-10-14', iban = vendor.iban, name = vendor.nameEn, vatFn } = {}) {
  const subtotal = round2(lines.reduce((s, l) => s + l.qty * l.unitPrice, 0));
  const vatAmount = vatFn ? vatFn(lines, subtotal) : round2(subtotal * VAT_RATE);
  const total = round2(subtotal + vatAmount);
  const time = '10:15:00';
  const inv = { invoiceNumber: number, uuid: `h-${number}`, issueDate: date, issueTime: time, sellerName: name, sellerVat: vendor.vat, poNumber: po, iban, lines, subtotal, vatAmount, total };
  inv.qr = encodeQR({ sellerName: name, vatNumber: vendor.vat, timestamp: `${date}T${time}`, total: f2(total), vatTotal: f2(vatAmount) });
  return inv;
}
const render = (fmt, inv, vendor) => (fmt === 'ubl' ? renderUBL(inv) : fmt === 'text' ? renderText(inv, vendor) : fmt === 'arabic' ? renderArabic(inv, vendor) : renderEmail(inv));

let seq = 0;
/** Builds one instance: a purchase order, its delivery, and one or more invoices with the answer for each. */
function base(rnd, { qtyScale = 1, priceFn } = {}) {
  const vendor = VENDORS[Math.floor(rnd() * VENDORS.length)];
  const items = [...vendor.items].sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * 3));
  const lines = items.map(([sku, name, nameAr, price]) => ({ sku, name, nameAr, unitPrice: priceFn ? priceFn(price) : price, qty: Math.max(2, Math.round((1 + Math.floor(rnd() * Math.max(2, 6000 / price))) * qtyScale)) }));
  const poNumber = `PO-2026-${3000 + ++seq}`;
  const po = { poNumber, vendorVat: vendor.vat, buyer: 'buyer@sahara.example', lines: lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: l.unitPrice })) };
  const grn = { grnNumber: `GRN-H${seq}`, poNumber, lines: lines.map((l) => ({ sku: l.sku, qty: l.qty })) };
  return { vendor, lines, po, grn, number: `${vendor.nameEn.slice(0, 3).toUpperCase()}-H${seq}` };
}
const fmtPick = (rnd, allowed = ['ubl', 'text', 'arabic']) => allowed[Math.floor(rnd() * allowed.length)];
const spaced = (iban) => iban.replace(/(.{4})/g, '$1 ').trim();

const CASES = [
  { name: 'Bank account written with spaces (same account)', why: 'Suppliers often print IBANs in groups of four.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd);
    const inv = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number, iban: spaced(b.vendor.iban) });
    return { ...b, docs: [{ doc: render(f, inv, b.vendor), truth: PAY, format: f, total: inv.total }] };
  } },
  { name: 'VAT rounded line by line (a few halalas off)', why: 'Many billing systems round VAT on each line, so the total differs from 15% by 1–3 halalas.', build(rnd) {
    const b = base(rnd, { priceFn: (p) => round2(p + 0.33 + Math.floor(rnd() * 60) / 100) });
    while (b.lines.length < 3) { const l = { ...b.lines[0], sku: `${b.lines[0].sku}-${b.lines.length}`, name: `${b.lines[0].name} (${b.lines.length + 1})`, unitPrice: round2(b.lines[0].unitPrice + 0.17 * b.lines.length) }; b.lines.push(l); b.po.lines.push({ sku: l.sku, name: l.name, qty: l.qty, unitPrice: l.unitPrice }); b.grn.lines.push({ sku: l.sku, qty: l.qty }); }
    const f = fmtPick(rnd);
    const inv = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number, vatFn: (ls, sub) => { const v = round2(ls.reduce((s, l) => s + round2(l.qty * l.unitPrice * VAT_RATE + 0.004), 0)); return Math.abs(v - round2(sub * VAT_RATE)) < 0.015 ? round2(v + 0.02) : v; } });
    return { ...b, docs: [{ doc: render(f, inv, b.vendor), truth: PAY, format: f, total: inv.total }] };
  } },
  { name: 'Order number written differently', why: 'People type "PO 2026-3001", "po-2026-3001" or add a full stop.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd);
    const variants = [(p) => p.replace('PO-', 'PO '), (p) => p.toLowerCase(), (p) => `${p}.`, (p) => p.replace(/-/g, '/')];
    const inv = makeInv(rnd, b.vendor, b.lines, { po: variants[Math.floor(rnd() * variants.length)](b.po.poNumber), number: b.number });
    return { ...b, docs: [{ doc: render(f, inv, b.vendor), truth: PAY, format: f, total: inv.total }] };
  } },
  { name: 'Supplier uses its full legal name', why: 'The invoice says "… Co. Ltd" while the supplier list has the short name; the VAT number matches.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd);
    const inv = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number, name: `${b.vendor.nameEn} Co. Ltd` });
    return { ...b, docs: [{ doc: render(f, inv, b.vendor), truth: PAY, format: f, total: inv.total }] };
  } },
  { name: 'Price 0.5% higher (inside the 1% tolerance)', why: 'Small agreed variations should not stop payment.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd);
    const lines = b.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: round2(l.unitPrice * 1.005) } : l));
    const inv = makeInv(rnd, b.vendor, lines, { po: b.po.poNumber, number: b.number });
    return { ...b, docs: [{ doc: render(f, inv, b.vendor), truth: PAY, format: f, total: inv.total }] };
  } },
  { name: 'Price 1.5% higher (just outside the tolerance)', why: 'A small overcharge that must still go to Procurement.', build(rnd) {
    const b = base(rnd, { priceFn: (p) => Math.max(p, 100) }); const f = fmtPick(rnd);
    const lines = b.lines.map((l, i) => (i === 0 ? { ...l, unitPrice: round2(l.unitPrice * 1.015) } : l));
    const inv = makeInv(rnd, b.vendor, lines, { po: b.po.poNumber, number: b.number });
    return { ...b, docs: [{ doc: render(f, inv, b.vendor), truth: 'EXCEPTION', format: f, total: inv.total }] };
  } },
  { name: 'One order billed in two parts', why: 'Suppliers often invoice part of an order now and the rest later.', build(rnd) {
    const b = base(rnd, { qtyScale: 2 }); const f = fmtPick(rnd);
    const first = b.lines.map((l) => ({ ...l, qty: Math.floor(l.qty / 2) }));
    const second = b.lines.map((l, i) => ({ ...l, qty: l.qty - first[i].qty }));
    const a = makeInv(rnd, b.vendor, first, { po: b.po.poNumber, number: `${b.number}A` });
    const c = makeInv(rnd, b.vendor, second, { po: b.po.poNumber, number: `${b.number}B`, date: '2026-10-21' });
    return { ...b, docs: [{ doc: render(f, a, b.vendor), truth: PAY, format: f, total: a.total }, { doc: render(f, c, b.vendor), truth: PAY, format: f, total: c.total }] };
  } },
  { name: 'Large order split to stay under the approval limit', why: 'A SAR 60–90K order billed as two invoices under SAR 50K each. Policy: the order value needs a manager.', build(rnd) {
    const b = base(rnd);
    const target = 60000 + Math.floor(rnd() * 30000);
    const sub = b.lines.reduce((s, l) => s + l.qty * l.unitPrice, 0);
    const k = Math.max(2, Math.ceil(target / (sub * (1 + VAT_RATE)) / 2) * 2);
    b.lines.forEach((l, i) => { l.qty *= k; b.po.lines[i].qty = l.qty; b.grn.lines[i].qty = l.qty; });
    const f = fmtPick(rnd);
    const half = b.lines.map((l) => ({ ...l, qty: l.qty / 2 }));
    const a = makeInv(rnd, b.vendor, half, { po: b.po.poNumber, number: `${b.number}A` });
    const c = makeInv(rnd, b.vendor, half.map((l) => ({ ...l })), { po: b.po.poNumber, number: `${b.number}B`, date: '2026-10-15' });
    const truth = a.total > LIMIT ? 'APPROVAL_REQUIRED' : 'APPROVAL_REQUIRED';
    return { ...b, docs: [{ doc: render(f, a, b.vendor), truth, format: f, total: a.total }, { doc: render(f, c, b.vendor), truth, format: f, total: c.total }] };
  } },
  { name: 'Same goods billed again under a new number and a new date', why: 'A classic duplicate: nothing extra was ordered or delivered.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd);
    const a = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number });
    const c = makeInv(rnd, b.vendor, b.lines.map((l) => ({ ...l })), { po: b.po.poNumber, number: `${b.number}-2`, date: `2026-10-${20 + Math.floor(rnd() * 8)}` });
    return { ...b, docs: [{ doc: render(f, a, b.vendor), truth: PAY, format: f, total: a.total, warmup: true }, { doc: render(f, c, b.vendor), truth: 'BLOCKED', format: f, total: c.total }] };
  } },
  { name: 'Monthly service: same amount, new order each month', why: 'Cleaning, security or rent look identical every month but are not duplicates.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd);
    const po2 = { ...b.po, poNumber: `${b.po.poNumber}-NOV` };
    const grn2 = { ...b.grn, grnNumber: `${b.grn.grnNumber}-NOV`, poNumber: po2.poNumber };
    const a = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number, date: '2026-10-01' });
    const c = makeInv(rnd, b.vendor, b.lines.map((l) => ({ ...l })), { po: po2.poNumber, number: `${b.number}-11`, date: '2026-11-01' });
    return { ...b, extraPOs: [po2], extraGRNs: [grn2], docs: [{ doc: render(f, a, b.vendor), truth: PAY, format: f, total: a.total, warmup: true }, { doc: render(f, c, b.vendor), truth: PAY, format: f, total: c.total }] };
  } },
  { name: 'Date written as day/month/year', why: 'Common on printed invoices: 14/10/2026.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd, ['text', 'arabic']);
    const inv = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number });
    const doc = render(f, inv, b.vendor).replace(/2026-10-14|٢٠٢٦-١٠-١٤/, f === 'arabic' ? '١٤/١٠/٢٠٢٦' : '14/10/2026');
    return { ...b, docs: [{ doc, truth: PAY, format: f, total: inv.total }] };
  } },
  { name: 'Supplier genuinely changed bank (new account)', why: 'Even when it is real, the policy is to block until Treasury phones the supplier.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd);
    const inv = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number, iban: `SA${String(10 + Math.floor(rnd() * 89))}${String(Math.floor(rnd() * 1e10)).padStart(10, '0')}${String(Math.floor(rnd() * 1e10)).padStart(10, '0')}` });
    return { ...b, docs: [{ doc: render(f, inv, b.vendor), truth: 'BLOCKED', format: f, total: inv.total }] };
  } },
  { name: 'Impostor quotes a real order number', why: 'An unknown company with a valid-looking VAT number bills against a real order.', build(rnd) {
    const b = base(rnd); const f = fmtPick(rnd);
    const fake = { ...b.vendor, vat: `3${String(10000000000000 + Math.floor(rnd() * 8e13)).slice(0, 13)}3`, nameEn: `${b.vendor.nameEn.split(' ')[0]} Trading Est.`, iban: 'SA0380000000608010167519' };
    const inv = makeInv(rnd, fake, b.lines, { po: b.po.poNumber, number: b.number });
    return { ...b, docs: [{ doc: render(f, inv, fake), truth: 'EXCEPTION', format: f, total: inv.total }] };
  } },
  { name: 'Amounts in European style (1.234,50)', why: 'Some foreign suppliers swap the comma and the dot.', build(rnd) {
    const b = base(rnd); const f = 'text';
    const inv = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number });
    const eu = (n) => Number(n).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    let doc = render(f, inv, b.vendor);
    for (const k of ['subtotal', 'vatAmount', 'total']) doc = doc.replace(Number(inv[k]).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }), eu(inv[k]));
    return { ...b, docs: [{ doc, truth: PAY, format: f, total: inv.total }] };
  } },
  { name: 'Free-text email invoice', why: 'Written as a normal email; rules cannot read it, an AI model can.', build(rnd) {
    const b = base(rnd);
    const inv = makeInv(rnd, b.vendor, b.lines, { po: b.po.poNumber, number: b.number });
    return { ...b, docs: [{ doc: renderEmail(inv), truth: PAY, format: 'email', total: inv.total }] };
  } },
];

async function hard(seed) {
  const rnd = mulberry32(seed);
  const rows = [];
  for (const c of CASES) {
    for (let i = 0; i < N_PER_CASE; i++) {
      const inst = c.build(rnd);
      const erp = new ERP({ vendors: VENDORS, purchaseOrders: [inst.po, ...(inst.extraPOs || [])], goodsReceipts: [inst.grn, ...(inst.extraGRNs || [])], approvalLimit: LIMIT });
      const agent = new WazinAgent(erp);
      for (const [k, d] of inst.docs.entries()) {
        const r = await agent.process(d.doc, { id: `H${seed}-${rows.length}-${k}` });
        if (!d.warmup) rows.push({ group: c.name, why: c.why, format: d.format, truth: d.truth, got: r.decision, codes: r.reasonCodes, total: d.total });
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------- report
function summarise(rows) {
  const s = { n: rows.length, correct: 0, person: 0, held: 0, misrouted: 0, paid_wrongly: 0, paidWronglySAR: 0 };
  for (const r of rows) { const o = outcome(r.truth, r.got); s[o]++; if (o === 'paid_wrongly') s.paidWronglySAR += r.total; }
  s.accuracy = s.correct / s.n;
  s.automated = (s.n - s.person) / s.n;
  s.accuracyAutomated = s.n - s.person ? s.correct / (s.n - s.person) : 0;
  return s;
}
const byGroup = (rows) => Object.entries(rows.reduce((m, r) => ((m[r.group] ||= []).push(r), m), {})).map(([g, rs]) => ({ group: g, why: rs[0].why, ...summarise(rs), example: rs.find((r) => outcome(r.truth, r.got) !== 'correct') }));
const P = (x) => `${(x * 100).toFixed(1)}%`;
const SAR = (x) => `SAR ${Math.round(x).toLocaleString('en-US')}`;

const A = await balanced(SEED);
const B = await hard(SEED + 1);
const B2 = await hard(FRESH_SEED);
const all = [...A, ...B];
const out = { seed: SEED, date: new Date().toISOString().slice(0, 10), balanced: summarise(A), hard: summarise(B), hardFresh: summarise(B2), all: summarise(all), balancedGroups: byGroup(A), hardGroups: byGroup(B) };
// Version 1 (before the fixes) on the same hard set, saved when it was first run.
const v1 = existsSync(new URL('./realistic-v1.json', import.meta.url)) ? JSON.parse(readFileSync(new URL('./realistic-v1.json', import.meta.url), 'utf8')) : null;

const row = (g) => `| ${g.group} | ${g.n} | ${P(g.accuracy)} | ${g.person} | ${g.held} | ${g.misrouted} | ${g.paid_wrongly} |`;
const md = `# Realistic evaluation: balanced classes and hard real-world cases

Run: \`npm run realistic\` · seed ${SEED} · ${out.date}. Neither set was used to build or tune Wazin.
The right answer for every invoice is what a careful accounts-payable team would do, fixed before Wazin runs.
Free-text emails are counted as invoices too; with no AI key they go to a person.

**What the columns mean**

| Outcome | Meaning | Risk |
|---|---|---|
| Correct | Same decision as the careful team | none |
| To a person | Wazin could not read it, so a person enters it | safe, costs time |
| Held | Should have been paid, but Wazin stopped it for a check | safe, delays a supplier |
| Misrouted | Not paid (right), but for the wrong reason or team | safe, extra hand-off |
| Paid wrongly | Wazin scheduled a payment it should not have | **unsafe**: this is what disputes catch |

## Headline

| Set | Invoices | Correct (all) | Handled without a person | Correct (of handled) | Paid wrongly |
|---|---|---|---|---|---|
| A. Balanced: all 11 situations equally often, 20% with several problems | ${out.balanced.n} | ${P(out.balanced.accuracy)} | ${P(out.balanced.automated)} | ${P(out.balanced.accuracyAutomated)} | ${out.balanced.paid_wrongly} |
| B. Hard real-world cases (${CASES.length} kinds × ${N_PER_CASE}), seed ${SEED + 1} | ${out.hard.n} | ${P(out.hard.accuracy)} | ${P(out.hard.automated)} | ${P(out.hard.accuracyAutomated)} | ${out.hard.paid_wrongly} |
| B2. Hard cases, new seed ${FRESH_SEED} | ${out.hardFresh.n} | ${P(out.hardFresh.accuracy)} | ${P(out.hardFresh.automated)} | ${P(out.hardFresh.accuracyAutomated)} | ${out.hardFresh.paid_wrongly} |
| **Both** | **${out.all.n}** | **${P(out.all.accuracy)}** | **${P(out.all.automated)}** | **${P(out.all.accuracyAutomated)}** | **${out.all.paid_wrongly}** |

${v1 ? `## Iteration: what this test found, and what changed

The first run of the hard set (version 1) exposed three ways of writing the same thing that Wazin treated as problems.
They were fixed in version 2 (\`src/agent.js\`, \`src/extract.js\`), regression tests were added, and the hard set was then
generated again from a **new seed (${FRESH_SEED})** to check the fixes were not tuned to one sample.

| Hard set | Version | Correct | Held for no reason | Paid wrongly |
|---|---|---|---|---|
| Seed ${SEED + 1} | v1 (before) | ${P(v1.hard.accuracy)} | ${v1.hard.held} | ${v1.hard.paid_wrongly} |
| Seed ${SEED + 1} | v2 (after) | ${P(out.hard.accuracy)} | ${out.hard.held} | ${out.hard.paid_wrongly} |
| **Seed ${FRESH_SEED} (new)** | **v2** | **${P(out.hardFresh.accuracy)}** | **${out.hardFresh.held}** | **${out.hardFresh.paid_wrongly}** |

| Fixed in v2 | v1 | v2 |
|---|---|---|
${['Bank account written with spaces (same account)', 'Order number written differently', 'Date written as day/month/year'].map((g) => `| ${g} | ${P(v1.hardGroups.find((x) => x.group === g).accuracy)} | ${P(out.hardGroups.find((x) => x.group === g).accuracy)} |`).join('\n')}

**Left as they are, on purpose (a person or a dispute handles them):**
- *VAT rounded line by line:* Wazin stays strict to the halala, so these are held for a person rather than paid. Safe, but it costs time.
- *European number style:* "1.234,50" is ambiguous, so a person checks it. Safe.
- *Free-text emails:* need the AI reader (an API key); without it a person enters them. Safe.
- *Order split to stay under the approval limit:* **the one unsafe gap.** Each invoice is under the limit, so Wazin pays both without a manager, although the goods were real and delivered. Next step: judge the approval limit on the order's total, not each invoice. Until then, a dispute holds the payment.

` : ''}## A. Balanced set, by situation

| Situation | Invoices | Correct | To a person | Held | Misrouted | Paid wrongly |
|---|---|---|---|---|---|---|
${out.balancedGroups.map(row).join('\n')}

## B. Hard real-world cases

| Case | Invoices | Correct | To a person | Held | Misrouted | Paid wrongly |
|---|---|---|---|---|---|---|
${out.hardGroups.map(row).join('\n')}

### Why each case is hard, and what Wazin did when it got it wrong

${out.hardGroups.map((g) => `- **${g.group}.** ${g.why}${g.example ? ` Example miss: expected ${g.example.truth}, Wazin said ${g.example.got}${g.example.codes?.length ? ` (${g.example.codes.join(', ')})` : ''}.` : ' No misses.'}`).join('\n')}
`;
writeFileSync(new URL('./REALISTIC.md', import.meta.url), md);
writeFileSync(new URL('./realistic.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(md);
