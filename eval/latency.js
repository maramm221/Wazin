// Speed: how long Wazin takes to decide, on its own and through the web server.
// Usage: node eval/latency.js  ->  eval/LATENCY.md
import { writeFileSync, readFileSync } from 'node:fs';
import { buildScenario } from '../data/generate.js';
import { ERP } from '../src/erp.js';
import { WazinAgent } from '../src/agent.js';
import { startApp } from '../test/helpers.js';

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
const stats = (a) => { a.sort((x, y) => x - y); return { mean: a.reduce((s, x) => s + x, 0) / a.length, p50: pct(a, 0.5), p95: pct(a, 0.95) }; };

// 1. The agent alone: 300 invoices of every kind.
const sc = buildScenario({ seed: 70101, n: 300 });
const erp = new ERP({ vendors: sc.vendors, purchaseOrders: sc.purchaseOrders, goodsReceipts: sc.goodsReceipts, approvalLimit: sc.approvalLimit });
const agent = new WazinAgent(erp);
const decide = [];
for (const e of sc.invoices) { const s = process.hrtime.bigint(); await agent.process(e.doc, { id: e.id }); decide.push(Number(process.hrtime.bigint() - s) / 1e6); }

// 2. Through the web server: upload, decide, encrypt and save, with sign-in and permission checks.
const app = await startApp({ WAZIN_LOGIN_LIMIT: '1000' });
const c = app.client(); await c.as('admin');
const doc = readFileSync(new URL('../public/samples/01-paid-automatically.xml', import.meta.url), 'utf8');
const upload = [];
for (let i = 0; i < 50; i++) {
  const d = doc.replace(/ALN-25117/g, `ALN-${70000 + i}`).replace(/<cbc:UUID>[^<]*/, `<cbc:UUID>lat-${i}`);
  const s = performance.now(); await c.call('POST', '/api/invoices', { doc: d }); upload.push(performance.now() - s);
}
const dash = [];
for (let i = 0; i < 20; i++) { const s = performance.now(); await c.call('GET', '/api/dashboard'); dash.push(performance.now() - s); }
await app.stop();

const a = stats(decide), u = stats(upload), d = stats(dash);
const f = (x) => `${x.toFixed(1)} ms`;
const md = `# Speed (latency)

Run: \`npm run latency\` · ${new Date().toISOString().slice(0, 10)} · Node ${process.version}. Measured on the server itself; over the internet, network time is added.

| What | Runs | Average | Median | 95% of runs under |
|---|---|---|---|---|
| Agent decision (read, all checks, decide) | ${decide.length} invoices | ${f(a.mean)} | ${f(a.p50)} | ${f(a.p95)} |
| Upload through the web server (sign-in check, decide, encrypt, save) | ${upload.length} | ${f(u.mean)} | ${f(u.p50)} | ${f(u.p95)} |
| Dashboard | ${dash.length} | ${f(d.mean)} | ${f(d.p50)} | ${f(d.p95)} |

Free-text emails read by an AI model add the model's response time (typically a few seconds) for those invoices only.
`;
writeFileSync(new URL('./LATENCY.md', import.meta.url), md);
console.log(md);
