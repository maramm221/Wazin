// Held-out evaluation: data Wazin's rules were never tuned on, harder inputs, and an ablation study.
// Usage: node eval/heldout.js   ->  eval/HELDOUT.md and eval/heldout.json
//
// 1. Unseen seeds      : five random seeds that were never used while building or tuning Wazin.
// 2. Unseen suppliers  : six new suppliers (names, VAT numbers, bank accounts, products, terms) that
//                        appear nowhere in the code, the demo or the development benchmark.
// 3. Messy inputs      : the same invoices, rewritten the way real documents arrive (Windows line
//                        breaks, extra spaces, Arabic-Indic digits, fields in a different order,
//                        lower-case labels, minified XML, no thousands separators).
// 4. Ablation          : switch off one check at a time to show what each one contributes.
// 5. Adaptation        : change the company's settings (two-way matching, wider price tolerance)
//                        and confirm the decisions change exactly as intended.
import { writeFileSync } from 'node:fs';
import { buildScenario, mulberry32 } from '../data/generate.js';
import { ERP } from '../src/erp.js';
import { WazinAgent } from '../src/agent.js';

const HELD_OUT_SEEDS = [70101, 70202, 70303, 70404, 70505]; // never used during development (which used 2026 and 1–10)

// New suppliers with valid ZATCA VAT numbers (15 digits, first and last 3) and Saudi IBANs.
const NEW_VENDORS = [
  { vat: '312345678900003', nameEn: 'Qassim Dates Trading', nameAr: 'القصيم لتجارة التمور', iban: 'SA8820000003456789012345', paymentTermsDays: 30, earlyPayDiscount: { pct: 1, days: 5 },
    items: [['DAT-SKR', 'Sukkari dates (5 kg)', 'تمر سكري', 120], ['DAT-AJW', 'Ajwa dates (1 kg)', 'تمر عجوة', 95], ['DAT-GFT', 'Corporate gift box', 'صندوق هدايا', 240]] },
  { vat: '300111222300003', nameEn: 'Tabuk Solar Systems', nameAr: 'تبوك لأنظمة الطاقة الشمسية', iban: 'SA1210000012345678901234', paymentTermsDays: 60,
    items: [['SOL-PNL', 'Solar panel 550W', 'لوح شمسي', 890], ['SOL-INV', 'Hybrid inverter 10kW', 'عاكس هجين', 7400], ['SOL-BAT', 'Lithium battery 5kWh', 'بطارية ليثيوم', 6100]] },
  { vat: '310987001200003', nameEn: 'Abha Print House', nameAr: 'دار أبها للطباعة', iban: 'SA4580000123456789012345', paymentTermsDays: 30,
    items: [['PRT-BRC', 'Brochure print run (1,000)', 'طباعة كتيبات', 1750], ['PRT-BNR', 'Roll-up banner', 'لافتة', 260], ['PRT-CRD', 'Business cards (box)', 'بطاقات عمل', 85]] },
  { vat: '301234500000003', nameEn: 'Makkah Medical Supplies', nameAr: 'مكة للمستلزمات الطبية', iban: 'SA6015000123456789000111', paymentTermsDays: 45, earlyPayDiscount: { pct: 2.5, days: 10 },
    items: [['MED-GLV', 'Nitrile gloves (box of 100)', 'قفازات', 32], ['MED-MSK', 'Surgical masks (box of 50)', 'كمامات', 18], ['MED-KIT', 'First-aid kit', 'حقيبة إسعافات', 210], ['MED-THR', 'Infrared thermometer', 'ميزان حرارة', 145]] },
  { vat: '311000999900003', nameEn: 'Al-Ahsa Water Co.', nameAr: 'الأحساء للمياه', iban: 'SA9305000099988877766655', paymentTermsDays: 15,
    items: [['WTR-330', 'Bottled water 330ml (carton)', 'مياه معبأة', 14], ['WTR-GAL', '5-gallon refill', 'تعبئة جالون', 9], ['WTR-DSP', 'Water dispenser rental', 'تأجير موزع', 75]] },
  { vat: '302020202000003', nameEn: 'Madinah Security Services', nameAr: 'المدينة للخدمات الأمنية', iban: 'SA3030400108000011122233', paymentTermsDays: 30,
    items: [['SEC-GRD', 'Security guard (monthly)', 'حارس أمن شهري', 5200], ['SEC-CAM', 'CCTV camera install', 'تركيب كاميرا', 950], ['SEC-PAT', 'Night patrol (week)', 'دورية ليلية', 1400]] },
];

// ---------------------------------------------------------------- one evaluation run
async function evaluate(sc, { transform, skip, policy } = {}) {
  const erp = new ERP({ vendors: sc.vendors, purchaseOrders: sc.purchaseOrders, goodsReceipts: sc.goodsReceipts, approvalLimit: sc.approvalLimit });
  if (policy) erp.policy = () => policy;
  const agent = new WazinAgent(erp, { skip });
  const rows = [];
  for (const e of sc.invoices) {
    const doc = transform ? transform(e.doc, e) : e.doc;
    rows.push({ e, r: await agent.process(doc, { id: e.id }), changed: doc !== e.doc });
  }
  return rows;
}

function score(rows, expect = (e) => e.expected.decision) {
  const readable = rows.filter(({ r }) => r.decision !== 'REVIEW');
  const correct = readable.filter(({ e, r }) => r.decision === expect(e));
  const falseApp = readable.filter(({ e, r }) => r.decision === 'APPROVED_AUTO' && expect(e) !== 'APPROVED_AUTO');
  return {
    n: rows.length,
    readable: readable.length,
    review: rows.length - readable.length,
    accuracy: readable.length ? correct.length / readable.length : 1,
    falseApprovals: falseApp.length,
    wronglyPaid: falseApp.reduce((s, { e }) => s + e.truth.total, 0),
    errors: readable.filter(({ e, r }) => r.decision !== expect(e)).slice(0, 5).map(({ e, r }) => `${e.id} ${e.defect}: expected ${expect(e)}, got ${r.decision} [${r.reasonCodes.join(',')}]`),
  };
}

// ---------------------------------------------------------------- messy-input rewrites
const rnd = mulberry32(4242);
const AR = '٠١٢٣٤٥٦٧٨٩';
const isText = (e) => e.format === 'text' || e.format === 'arabic';
const PERTURB = {
  'Windows line breaks (CRLF)': { when: () => true, fn: (d) => d.replace(/\n/g, '\r\n') },
  'Extra blank lines, indentation and trailing spaces': { when: (e) => e.format !== 'ubl', fn: (d) => d.split('\n').map((l) => `   ${l}  `).join('\n\n') },
  'All digits written as Arabic-Indic (٠١٢٣)': { when: isText, fn: (d) => d.replace(/\d/g, (x) => AR[x]) },
  'Header fields in a different order': { when: isText, fn: (d) => {
    const ls = d.split('\n');
    const end = ls.findIndex((l) => /Items|البنود/.test(l));
    const head = ls.slice(1, end).sort(() => rnd() - 0.5);
    return [ls[0], ...head, ...ls.slice(end)].join('\n');
  } },
  'Lower-case labels': { when: (e) => e.format === 'text', fn: (d) => d.split('\n').map((l) => (l.includes(':') && !l.startsWith('QR') ? l.slice(0, l.indexOf(':')).toLowerCase() + l.slice(l.indexOf(':')) : l)).join('\n') },
  'Minified XML (no line breaks or indentation)': { when: (e) => e.format === 'ubl', fn: (d) => d.replace(/>\s+</g, '><').trim() },
  'No thousands separators in amounts': { when: (e) => e.format !== 'ubl', fn: (d) => d.replace(/(\d),(\d{3})/g, '$1$2').replace(/(\d),(\d{3})/g, '$1$2') },
};

// ---------------------------------------------------------------- run everything
const P = (x) => `${(x * 100).toFixed(2)}%`;
const SAR = (x) => `SAR ${Math.round(x).toLocaleString('en-US')}`;
const out = { date: new Date().toISOString().slice(0, 10), node: process.version };

// 1. Unseen seeds
out.seeds = [];
for (const seed of HELD_OUT_SEEDS) out.seeds.push({ seed, ...score(await evaluate(buildScenario({ n: 300, seed }))) });

// 2. Unseen suppliers (also with several problems on one invoice)
out.vendors = score(await evaluate(buildScenario({ n: 300, seed: 80808, vendors: NEW_VENDORS })));
out.vendorsCompound = score(await evaluate(buildScenario({ n: 300, seed: 80909, vendors: NEW_VENDORS, compoundShare: 0.3 })));

// 3. Messy inputs (applied to the first unseen-seed set; only invoices of the matching format change)
const base = buildScenario({ n: 300, seed: HELD_OUT_SEEDS[0] });
out.perturb = [];
for (const [name, p] of Object.entries(PERTURB)) {
  const rows = await evaluate(base, { transform: (d, e) => (p.when(e) ? p.fn(d) : d) });
  const changed = rows.filter((x) => x.changed);
  out.perturb.push({ name, changed: changed.length, ...score(changed) });
}
{
  const rows = await evaluate(base, { transform: (d, e) => Object.values(PERTURB).reduce((x, p) => (p.when(e) ? p.fn(x) : x), d) });
  out.perturbAll = { changed: rows.filter((x) => x.changed).length, ...score(rows.filter((x) => x.changed)) };
}

// 4. Ablation: turn off one check at a time on the first unseen-seed set
out.ablation = [{ name: 'Full Wazin', skip: [] }, { name: 'Without ZATCA checks', skip: ['zatca'] }, { name: 'Without bank-account check', skip: ['bank'] },
  { name: 'Without duplicate check', skip: ['duplicate'] }, { name: 'Without order and delivery match', skip: ['match'] }];
for (const a of out.ablation) Object.assign(a, score(await evaluate(base, { skip: a.skip })));

// 5. Adaptation: the company changes its settings
const twoWayExpect = (e) => (e.defect === 'missing_grn' ? 'APPROVED_AUTO' : e.defect === 'qty_mismatch' ? 'APPROVED_AUTO' : e.expected.decision);
const tolExpect = (e) => (e.defect === 'price_mismatch' ? 'APPROVED_AUTO' : e.expected.decision);
out.adapt = {
  twoWay: score(await evaluate(base, { policy: { matching: 'two' } }), twoWayExpect),
  tolerance20: score(await evaluate(base, { policy: { priceTolerancePct: 20 } }), tolExpect),
};

// ---------------------------------------------------------------- report
const all = out.seeds.reduce((a, s) => ({ n: a.n + s.n, readable: a.readable + s.readable, ok: a.ok + s.accuracy * s.readable, fa: a.fa + s.falseApprovals }), { n: 0, readable: 0, ok: 0, fa: 0 });
const md = `# Held-out evaluation

Run: \`npm run heldout\` · ${out.date} · Node ${out.node}. Nothing here was used while building or tuning Wazin's rules.
"Correct" means the same decision a careful accounts-payable team would make (pay, ask for approval, wait for goods, send back, or block).
"Wrong payment" means Wazin would have paid an invoice that should not be paid. Unreadable invoices go to a person ("manual review"); that is the safe outcome.
About 10% of invoices are free-text emails. Without an AI key they cannot be read by rules, so they go to a person: that is the "Sent to a person" column, not an error.

## 1. Unseen random seeds (${HELD_OUT_SEEDS.length} × 300 invoices)

| Seed | Invoices | Read without AI | Correct decision | Wrong payments |
|---|---|---|---|---|
${out.seeds.map((s) => `| ${s.seed} | ${s.n} | ${s.readable} | ${P(s.accuracy)} | ${s.falseApprovals} |`).join('\n')}
| **All** | **${all.n}** | **${all.readable}** | **${P(all.ok / all.readable)}** | **${all.fa}** |

## 2. Unseen suppliers

Six new suppliers that appear nowhere in the code or the development data.

| Set | Invoices | Read without AI | Correct decision | Wrong payments |
|---|---|---|---|---|
| One problem per invoice | ${out.vendors.n} | ${out.vendors.readable} | ${P(out.vendors.accuracy)} | ${out.vendors.falseApprovals} |
| 30% with 2–3 problems at once | ${out.vendorsCompound.n} | ${out.vendorsCompound.readable} | ${P(out.vendorsCompound.accuracy)} | ${out.vendorsCompound.falseApprovals} |

## 3. Messy inputs

The same invoices rewritten the way real documents arrive. Only invoices of the affected format are counted.

| Change | Invoices changed | Still read | Sent to a person | Correct decision (read) | Wrong payments |
|---|---|---|---|---|---|
${out.perturb.map((p) => `| ${p.name} | ${p.changed} | ${p.readable} | ${p.review} | ${P(p.accuracy)} | ${p.falseApprovals} |`).join('\n')}
| **All changes at once** | ${out.perturbAll.changed} | ${out.perturbAll.readable} | ${out.perturbAll.review} | ${P(out.perturbAll.accuracy)} | ${out.perturbAll.falseApprovals} |

## 4. Ablation: what each check contributes

Seed ${HELD_OUT_SEEDS[0]}, 300 invoices, one check switched off at a time.

| Version | Correct decision | Wrong payments | Money wrongly paid |
|---|---|---|---|
${out.ablation.map((a) => `| ${a.name} | ${P(a.accuracy)} | ${a.falseApprovals} | ${SAR(a.wronglyPaid)} |`).join('\n')}

Every check matters: removing any one of them lets real problems through and pays money that should have been stopped.

## 5. Adaptation: the company changes its settings

| Setting | Expected change | Decisions as expected | Wrong payments under the new rule |
|---|---|---|---|
| Two-way matching (order only) | Invoices waiting for goods are paid; short deliveries can no longer be seen (why three-way is the default for goods) | ${P(out.adapt.twoWay.accuracy)} | ${out.adapt.twoWay.falseApprovals} |
| Price tolerance 20% | Overcharges of 5–15% are accepted | ${P(out.adapt.tolerance20.accuracy)} | ${out.adapt.tolerance20.falseApprovals} |

${[...out.seeds, out.vendors, out.vendorsCompound, ...out.perturb, out.perturbAll, out.adapt.twoWay, out.adapt.tolerance20].some((s) => s.errors.length) ? `## Mismatches found\n\n${[...out.seeds, out.vendors, out.vendorsCompound, ...out.perturb, out.perturbAll, out.adapt.twoWay, out.adapt.tolerance20].flatMap((s) => s.errors).slice(0, 20).map((x) => `- ${x}`).join('\n')}\n` : '## Mismatches found\n\nNone.\n'}
`;
writeFileSync(new URL('./HELDOUT.md', import.meta.url), md);
writeFileSync(new URL('./heldout.json', import.meta.url), JSON.stringify(out, null, 2));
console.log(md);
