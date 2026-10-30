// Regression gate: the labelled benchmark must keep its quality bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runBenchmark } from '../eval/run.js';
import { buildScenario } from '../data/generate.js';

test('benchmark is deterministic for a given seed', () => {
  const a = buildScenario({ n: 50, seed: 7 }), b = buildScenario({ n: 50, seed: 7 });
  assert.deepEqual(a.invoices.map((i) => i.doc), b.invoices.map((i) => i.doc));
});

test('300-invoice benchmark: ≥99% accuracy, zero false approvals, all parked invoices clear', async () => {
  const { summary } = await runBenchmark({ n: 300, seed: 2026 });
  assert.ok(summary.decisionAccuracy >= 0.99, `accuracy ${summary.decisionAccuracy}`);
  assert.ok(summary.exactReasonMatch >= 0.99);
  assert.equal(summary.falseApprovals, 0);
  assert.equal(summary.resume.clearedAfterGRN, summary.resume.parked);
  assert.ok(summary.compute.reductionPct > 90);
});

test('compound-defect stress run (2–3 issues per invoice) keeps zero false approvals', async () => {
  const { summary } = await runBenchmark({ n: 300, seed: 99, compoundShare: 0.3 });
  assert.equal(summary.falseApprovals, 0);
  assert.ok(summary.exactReasonMatch >= 0.99);
});
