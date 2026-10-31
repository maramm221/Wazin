# Wazin benchmark results

Run: 300 invoices · seed 2026 · LLM tier OFF (deterministic tiers only) · 2026-10-31 · Node v22.23.4

| Metric | Result |
|---|---|
| Invoices read without any LLM | 272 / 300 (90.7%) |
| Free-text invoices escalated to LLM tier | 28 |
| Decision accuracy (readable invoices) | **100.0%** |
| Exact reason-code match | **100.0%** |
| False auto-approvals (paid when it should not) | **0** |
| Clean invoices held unnecessarily | 0 |
| Touchless rate (all invoices) | 37.0% |
| Touchless rate on clean, readable invoices | 100.0% |
| Parked → auto-cleared when goods receipt arrived | 13 / 13 |
| SAR at risk caught (duplicates + bank diversion + overcharges) | SAR 364,383 |
| Early-payment discounts captured | SAR 5,598 |
| Latency per invoice (mean / p95) | 0.52 ms / 0.77 ms |
| LLM tokens: Wazin vs naive all-LLM agent (est.) | 18,497 vs 2,015,465 (−99.1%) |

## Per-check precision / recall
| Check | Support | Precision | Recall | F1 |
|---|---|---|---|---|
| AWAITING_GRN | 13 | 100.0% | 100.0% | 100.0% |
| BANK_DETAILS_CHANGED | 16 | 100.0% | 100.0% | 100.0% |
| DUPLICATE | 14 | 100.0% | 100.0% | 100.0% |
| INVALID_VAT_NUMBER | 15 | 100.0% | 100.0% | 100.0% |
| PO_NOT_FOUND | 19 | 100.0% | 100.0% | 100.0% |
| PRICE_VARIANCE | 28 | 100.0% | 100.0% | 100.0% |
| QR_MISMATCH | 15 | 100.0% | 100.0% | 100.0% |
| QTY_VARIANCE | 12 | 100.0% | 100.0% | 100.0% |
| VAT_CALC_ERROR | 18 | 100.0% | 100.0% | 100.0% |

## Accuracy by input format
| Format | n | Decision accuracy |
|---|---|---|
| ubl | 142 | 100.0% |
| text | 84 | 100.0% |
| arabic | 46 | 100.0% |
| email | 0 | — (escalated) |

Errors: 0
