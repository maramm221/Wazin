#!/usr/bin/env node
// Terminal demo: runs Wazin over the curated demo inbox, then posts the late goods receipt.
// Usage: node cli.js            (deterministic tiers only)
//        ANTHROPIC_API_KEY=... node cli.js --llm   (free-text email read by Claude)
import { buildDemo } from './data/demo.js';
import { ERP } from './src/erp.js';
import { WazinAgent } from './src/agent.js';
import { anthropicLLM } from './src/llm.js';

const C = { g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', b: '\x1b[36m', d: '\x1b[2m', x: '\x1b[0m', B: '\x1b[1m' };
const colorFor = { APPROVED_AUTO: C.g, APPROVAL_REQUIRED: C.b, PARKED: C.y, EXCEPTION: C.y, BLOCKED: C.r, REVIEW: C.d };
const mark = { ok: `${C.g}✓${C.x}`, warn: `${C.y}●${C.x}`, fail: `${C.r}✗${C.x}` };

const demo = buildDemo();
const agent = new WazinAgent(new ERP(demo), { llm: process.argv.includes('--llm') ? anthropicLLM() : undefined });

console.log(`${C.B}Wazin · وازِن — autonomous accounts payable${C.x}\n${C.d}${demo.inbox.length} invoices in the inbox${C.x}\n`);
for (const item of demo.inbox) {
  const r = await agent.process(item.doc, { id: item.id });
  console.log(`${C.B}${item.id}${C.x} ${item.vendor} · ${item.label} ${C.d}[${item.format}]${C.x}`);
  for (const s of r.steps) console.log(`   ${mark[s.status]} ${s.name.padEnd(17)} ${C.d}${s.detail}${C.x}`);
  console.log(`   ${colorFor[r.decision]}→ ${r.decisionLabel}${r.owner !== 'NONE' ? ` · ${r.ownerLabel}` : ''}${C.x}  ${C.d}(${r.ms} ms, ${r.usage.llmCalls} LLM call${r.usage.llmCalls === 1 ? '' : 's'})${C.x}\n`);
}
for (const g of demo.lateGRNs) {
  console.log(`${C.b}EVENT${C.x} warehouse posts ${g.grnNumber} for ${g.poNumber}`);
  for (const r of await agent.onGoodsReceipt(g)) console.log(`   ${colorFor[r.decision]}→ ${r.id} ${r.decisionLabel}${C.x}  ${C.d}${r.steps.at(-1).detail}${C.x}`);
}
const n = agent.log.length;
const touchless = agent.log.filter((r) => r.decision === 'APPROVED_AUTO').length;
console.log(`\n${C.B}Ledger:${C.x} ${agent.erp.ledger.length} invoices posted · touchless ${touchless}/${n} decisions · ${agent.log.reduce((s, r) => s + r.usage.llmCalls, 0)} LLM calls`);
