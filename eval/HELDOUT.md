# Held-out evaluation

Run: `npm run heldout` · 2026-10-30 · Node v22.23.4. Nothing here was used while building or tuning Wazin's rules.
"Correct" means the same decision a careful accounts-payable team would make (pay, ask for approval, wait for goods, send back, or block).
"Wrong payment" means Wazin would have paid an invoice that should not be paid. Unreadable invoices go to a person ("manual review"); that is the safe outcome.
About 10% of invoices are free-text emails. Without an AI key they cannot be read by rules, so they go to a person: that is the "Sent to a person" column, not an error.

## 1. Unseen random seeds (5 × 300 invoices)

| Seed | Invoices | Read without AI | Correct decision | Wrong payments |
|---|---|---|---|---|
| 70101 | 300 | 271 | 100.00% | 0 |
| 70202 | 300 | 270 | 100.00% | 0 |
| 70303 | 300 | 266 | 100.00% | 0 |
| 70404 | 300 | 272 | 100.00% | 0 |
| 70505 | 300 | 270 | 100.00% | 0 |
| **All** | **1500** | **1349** | **100.00%** | **0** |

## 2. Unseen suppliers

Six new suppliers that appear nowhere in the code or the development data.

| Set | Invoices | Read without AI | Correct decision | Wrong payments |
|---|---|---|---|---|
| One problem per invoice | 300 | 272 | 100.00% | 0 |
| 30% with 2–3 problems at once | 300 | 278 | 100.00% | 0 |

## 3. Messy inputs

The same invoices rewritten the way real documents arrive. Only invoices of the affected format are counted.

| Change | Invoices changed | Still read | Sent to a person | Correct decision (read) | Wrong payments |
|---|---|---|---|---|---|
| Windows line breaks (CRLF) | 300 | 271 | 29 | 100.00% | 0 |
| Extra blank lines, indentation and trailing spaces | 138 | 109 | 29 | 100.00% | 0 |
| All digits written as Arabic-Indic (٠١٢٣) | 109 | 109 | 0 | 100.00% | 0 |
| Header fields in a different order | 105 | 105 | 0 | 100.00% | 0 |
| Lower-case labels | 81 | 81 | 0 | 100.00% | 0 |
| Minified XML (no line breaks or indentation) | 162 | 162 | 0 | 100.00% | 0 |
| No thousands separators in amounts | 110 | 81 | 29 | 100.00% | 0 |
| **All changes at once** | 300 | 271 | 29 | 100.00% | 0 |

## 4. Ablation: what each check contributes

Seed 70101, 300 invoices, one check switched off at a time.

| Version | Correct decision | Wrong payments | Money wrongly paid |
|---|---|---|---|
| Full Wazin | 100.00% | 0 | SAR 0 |
| Without ZATCA checks | 82.66% | 47 | SAR 598,990 |
| Without bank-account check | 93.73% | 17 | SAR 180,752 |
| Without duplicate check | 94.46% | 12 | SAR 169,164 |
| Without order and delivery match | 76.38% | 64 | SAR 807,592 |

Every check matters: removing any one of them lets real problems through and pays money that should have been stopped.

## 5. Adaptation: the company changes its settings

| Setting | Expected change | Decisions as expected | Wrong payments under the new rule |
|---|---|---|---|
| Two-way matching (order only) | Invoices waiting for goods are paid; short deliveries can no longer be seen (why three-way is the default for goods) | 100.00% | 0 |
| Price tolerance 20% | Overcharges of 5–15% are accepted | 100.00% | 0 |

## Mismatches found

None.

