// Benchmark: run Wazin over a labelled synthetic invoice set and score it.
// Usage: node eval/run.js [--n 300] [--seed 2026] [--llm]
import { writeFileSync } from 'node:fs';
import { buildScenario } from '../data/generate.js';
import { ERP } from '../src/erp.js';
import { WazinAgent } from '../src/agent.js';
import { anthropicLLM } from '../src/llm.js';
import { estimateTokens } from '../src/extract.js';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const n = Number(arg('n', 300));
const seed = Number(arg('seed', 2026));
const llm = process.argv.includes('--llm') ? anthropicLLM() : undefined;
if (process.argv.includes('--llm') && !llm) console.warn('--llm given but ANTHROPIC_API_KEY is not set; running deterministic tiers only.');

export async function runBenchmark({ n, seed, llm, compoundShare = 0 }) {
  const sc = buildScenario({ n, seed, compoundShare });
  const erp = new ERP({ vendors: sc.vendors, purchaseOrders: sc.purchaseOrders, goodsReceipts: sc.goodsReceipts, approvalLimit: sc.approvalLimit });
  const agent = new WazinAgent(erp, { llm });
  const rows = [];
  for (const e of sc.invoices) {
    const r = await agent.process(e.doc, { id: e.id });
    rows.push({ e, r });
  }
  // Late goods receipts arrive -> parked invoices should resume and clear without a human.
  const resumed = [];
  for (const g of sc.lateGRNs) resumed.push(...(await agent.onGoodsReceipt(g)));

  const readable = rows.filter(({ r }) => r.decision !== 'REVIEW');
  const escalated = rows.filter(({ r }) => r.decision === 'REVIEW');
  const correctDecision = (x) => x.r.decision === x.e.expected.decision;
  const sameCodes = (x) => JSON.stringify([...x.r.reasonCodes].sort()) === JSON.stringify([...x.e.expected.codes].sort());

  // Per-code precision / recall over readable invoices
  const codes = [...new Set(readable.flatMap((x) => [...x.e.expected.codes, ...x.r.reasonCodes]))].sort();
  const perCode = codes.map((c) => {
    let tp = 0, fp = 0, fn = 0;
    for (const x of readable) {
      const exp = x.e.expected.codes.includes(c), got = x.r.reasonCodes.includes(c);
      if (exp && got) tp++; else if (got) fp++; else if (exp) fn++;
    }
    const p = tp + fp ? tp / (tp + fp) : 1, rc = tp + fn ? tp / (tp + fn) : 1;
    return { code: c, support: tp + fn, tp, fp, fn, precision: p, recall: rc, f1: p + rc ? (2 * p * rc) / (p + rc) : 0 };
  });

  const dist = (arr, f) => arr.reduce((m, x) => ((m[f(x)] = (m[f(x)] || 0) + 1), m), {});
  const ms = rows.map(({ r }) => r.ms).sort((a, b) => a - b);
  const pct = (q) => ms[Math.min(ms.length - 1, Math.floor(q * ms.length))];

  // Money at risk caught: duplicate + diverted payments blocked, overcharges flagged.
  const caught = { duplicates: 0, bankDiversion: 0, overcharges: 0 };
  for (const { e, r } of readable) {
    if (e.defect === 'duplicate' && r.reasonCodes.includes('DUPLICATE')) caught.duplicates += e.truth.total;
    if (e.defect === 'iban_change' && r.reasonCodes.includes('BANK_DETAILS_CHANGED')) caught.bankDiversion += e.truth.total;
    for (const i of r.issues) if (i.code === 'PRICE_VARIANCE') caught.overcharges += i.overcharge * 1.15;
  }
  const discounts = rows.reduce((s, { r }) => s + (r.decision === 'APPROVED_AUTO' ? r.payment.discount : 0), 0);

  // Compute: Wazin (tiered) vs a naive "LLM reads + reasons at every step" design.
  // Naive estimate: 5 agent steps per invoice, each re-sending the document plus ~600 tokens of
  // instructions/context and ~250 output tokens. Clearly an estimate — see docs/METHOD.md.
  const naiveTokens = rows.reduce((s, { e }) => s + 5 * (estimateTokens(e.doc) + 600 + 250), 0);
  const wazinCalls = rows.reduce((s, { r }) => s + r.usage.llmCalls, 0);
  const wazinTokens = rows.reduce((s, { r }) => s + r.usage.llmTokens, 0);
  const wouldNeedLLM = rows.filter(({ r }) => r.decision === 'REVIEW').length;
  const projectedTokens = llm ? wazinTokens : rows.filter(({ r }) => r.decision === 'REVIEW').reduce((s, { e }) => s + estimateTokens(e.doc) + 250 + 250, 0);

  const summary = {
    run: { n, seed, llm: !!llm, date: new Date().toISOString().slice(0, 10), node: process.version },
    formats: dist(rows, (x) => x.e.format),
    defects: dist(rows, (x) => x.e.defect),
    readable: readable.length,
    escalated: escalated.length,
    decisionAccuracy: readable.filter(correctDecision).length / readable.length,
    exactReasonMatch: readable.filter(sameCodes).length / readable.length,
    decisionAccuracyByFormat: Object.fromEntries(['ubl', 'text', 'arabic', 'email'].map((f) => {
      const s = readable.filter((x) => x.e.format === f);
      return [f, s.length ? { n: s.length, accuracy: s.filter(correctDecision).length / s.length } : { n: 0, accuracy: null }];
    })),
    falseApprovals: readable.filter((x) => x.r.decision === 'APPROVED_AUTO' && x.e.expected.decision !== 'APPROVED_AUTO').length,
    falseHolds: readable.filter((x) => x.e.expected.decision === 'APPROVED_AUTO' && x.r.decision !== 'APPROVED_AUTO').length,
    perCode,
    decisions: dist(rows, (x) => x.r.decision),
    touchlessRate: rows.filter(({ r }) => r.decision === 'APPROVED_AUTO').length / rows.length,
    touchlessRateOnCleanReadable: readable.filter((x) => x.e.defect === 'clean' && x.r.decision === 'APPROVED_AUTO').length / Math.max(1, readable.filter((x) => x.e.defect === 'clean').length),
    resume: { parked: rows.filter(({ r }) => r.decision === 'PARKED').length, resumed: resumed.length, clearedAfterGRN: resumed.filter((r) => r.decision === 'APPROVED_AUTO' || r.decision === 'APPROVAL_REQUIRED').length },
    sarAtRiskCaught: { duplicates: Math.round(caught.duplicates), bankDiversion: Math.round(caught.bankDiversion), overchargesInclVat: Math.round(caught.overcharges), total: Math.round(caught.duplicates + caught.bankDiversion + caught.overcharges) },
    earlyPayDiscountsSAR: Math.round(discounts),
    latencyMs: { mean: Math.round((ms.reduce((a, b) => a + b, 0) / ms.length) * 100) / 100, p50: pct(0.5), p95: pct(0.95), max: ms[ms.length - 1] },
    compute: {
      llmCallsMade: wazinCalls,
      invoicesNeedingLLM: llm ? rows.filter(({ r }) => r.usage.tier === 3).length : wouldNeedLLM,
      wazinTokens: projectedTokens,
      wazinTokensNote: llm ? 'measured' : 'projected: 1 call per free-text invoice (prompt+doc+reply)',
      naiveAllLLMTokensEstimate: naiveTokens,
      reductionPct: Math.round((1 - projectedTokens / naiveTokens) * 1000) / 10,
    },
  };
  const errors = readable.filter((x) => !correctDecision(x) || !sameCodes(x)).map((x) => ({ id: x.e.id, format: x.e.format, defect: x.e.defect, expected: x.e.expected, got: { decision: x.r.decision, codes: x.r.reasonCodes } }));
  return { summary, errors };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const { summary, errors } = await runBenchmark({ n, seed, llm });
  writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify({ summary, errors }, null, 2));
  const P = (x) => `${(x * 100).toFixed(1)}%`;
  const md = `# Wazin benchmark results

Run: ${summary.run.n} invoices · seed ${summary.run.seed} · LLM tier ${summary.run.llm ? 'ON' : 'OFF (deterministic tiers only)'} · ${summary.run.date} · Node ${summary.run.node}

| Metric | Result |
|---|---|
| Invoices read without any LLM | ${summary.readable} / ${n} (${P(summary.readable / n)}) |
| Free-text invoices escalated to LLM tier | ${summary.escalated} |
| Decision accuracy (readable invoices) | **${P(summary.decisionAccuracy)}** |
| Exact reason-code match | **${P(summary.exactReasonMatch)}** |
| False auto-approvals (paid when it should not) | **${summary.falseApprovals}** |
| Clean invoices held unnecessarily | ${summary.falseHolds} |
| Touchless rate (all invoices) | ${P(summary.touchlessRate)} |
| Touchless rate on clean, readable invoices | ${P(summary.touchlessRateOnCleanReadable)} |
| Parked → auto-cleared when goods receipt arrived | ${summary.resume.clearedAfterGRN} / ${summary.resume.parked} |
| SAR at risk caught (duplicates + bank diversion + overcharges) | SAR ${summary.sarAtRiskCaught.total.toLocaleString()} |
| Early-payment discounts captured | SAR ${summary.earlyPayDiscountsSAR.toLocaleString()} |
| Latency per invoice (mean / p95) | ${summary.latencyMs.mean} ms / ${summary.latencyMs.p95} ms |
| LLM tokens: Wazin vs naive all-LLM agent (est.) | ${summary.compute.wazinTokens.toLocaleString()} vs ${summary.compute.naiveAllLLMTokensEstimate.toLocaleString()} (−${summary.compute.reductionPct}%) |

## Per-check precision / recall
| Check | Support | Precision | Recall | F1 |
|---|---|---|---|---|
${summary.perCode.map((c) => `| ${c.code} | ${c.support} | ${P(c.precision)} | ${P(c.recall)} | ${P(c.f1)} |`).join('\n')}

## Accuracy by input format
| Format | n | Decision accuracy |
|---|---|---|
${Object.entries(summary.decisionAccuracyByFormat).map(([f, v]) => `| ${f} | ${v.n} | ${v.accuracy === null ? '— (escalated)' : P(v.accuracy)} |`).join('\n')}

Errors: ${errors.length}${errors.length ? ' — see results.json' : ''}
`;
  writeFileSync(new URL('./RESULTS.md', import.meta.url), md);
  console.log(md);
}
