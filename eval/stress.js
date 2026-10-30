// Stress test: 10 random seeds × 300 invoices, 30% of eligible invoices carry 2–3 defects at once.
// Usage: node eval/stress.js
import { writeFileSync } from 'node:fs';
import { runBenchmark } from './run.js';

const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const runs = [];
for (const seed of seeds) {
  const { summary, errors } = await runBenchmark({ n: 300, seed, compoundShare: 0.3 });
  runs.push({ seed, readable: summary.readable, decisionAccuracy: summary.decisionAccuracy, exactReasonMatch: summary.exactReasonMatch, falseApprovals: summary.falseApprovals, compound: Object.entries(summary.defects).filter(([k]) => k.includes('+')).reduce((s, [, v]) => s + v, 0), errors: errors.length, sampleErrors: errors.slice(0, 3) });
}
const tot = runs.reduce((a, r) => ({ readable: a.readable + r.readable, ok: a.ok + r.decisionAccuracy * r.readable, exact: a.exact + r.exactReasonMatch * r.readable, fa: a.fa + r.falseApprovals, compound: a.compound + r.compound }), { readable: 0, ok: 0, exact: 0, fa: 0, compound: 0 });
const P = (x) => `${(x * 100).toFixed(2)}%`;
const md = `# Stress test — ${seeds.length} seeds × 300 invoices, compound defects on

| Seed | Readable | Compound-defect invoices | Decision acc. | Exact reasons | False approvals |
|---|---|---|---|---|---|
${runs.map((r) => `| ${r.seed} | ${r.readable} | ${r.compound} | ${P(r.decisionAccuracy)} | ${P(r.exactReasonMatch)} | ${r.falseApprovals} |`).join('\n')}
| **All** | **${tot.readable}** | **${tot.compound}** | **${P(tot.ok / tot.readable)}** | **${P(tot.exact / tot.readable)}** | **${tot.fa}** |
`;
writeFileSync(new URL('./STRESS.md', import.meta.url), md);
writeFileSync(new URL('./stress.json', import.meta.url), JSON.stringify(runs, null, 2));
console.log(md);
