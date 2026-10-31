# Realistic evaluation: balanced classes and hard real-world cases

Run: `npm run realistic` · seed 91919 · 2026-10-31. Neither set was used to build or tune Wazin.
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
| A. Balanced: all 11 situations equally often, 20% with several problems | 550 | 92.4% | 92.4% | 100.0% | 0 |
| B. Hard real-world cases (15 kinds × 20), seed 91920 | 340 | 70.0% | 94.1% | 74.4% | 38 |
| B2. Hard cases, new seed 92021 | 340 | 70.6% | 94.1% | 75.0% | 34 |
| **Both** | **890** | **83.8%** | **93.0%** | **90.1%** | **38** |

## Iteration: what this test found, and what changed

The first run of the hard set (version 1) exposed three ways of writing the same thing that Wazin treated as problems.
They were fixed in version 2 (`src/agent.js`, `src/extract.js`), regression tests were added, and the hard set was then
generated again from a **new seed (92021)** to check the fixes were not tuned to one sample.

| Hard set | Version | Correct | Held for no reason | Paid wrongly |
|---|---|---|---|---|
| Seed 91920 | v1 (before) | 57.1% | 64 | 38 |
| Seed 91920 | v2 (after) | 70.0% | 40 | 38 |
| **Seed 92021 (new)** | **v2** | **70.6%** | **40** | **34** |

| Fixed in v2 | v1 | v2 |
|---|---|---|
| Bank account written with spaces (same account) | 80.0% | 100.0% |
| Order number written differently | 0.0% | 100.0% |
| Date written as day/month/year | 0.0% | 100.0% |

**Left as they are, on purpose (a person or a dispute handles them):**
- *VAT rounded line by line:* Wazin stays strict to the halala, so these are held for a person rather than paid. Safe, but it costs time.
- *European number style:* "1.234,50" is ambiguous, so a person checks it. Safe.
- *Free-text emails:* need the AI reader (an API key); without it a person enters them. Safe.
- *Order split to stay under the approval limit:* **the one unsafe gap.** Each invoice is under the limit, so Wazin pays both without a manager, although the goods were real and delivered. Next step: judge the approval limit on the order's total, not each invoice. Until then, a dispute holds the payment.

## A. Balanced set, by situation

| Situation | Invoices | Correct | To a person | Held | Misrouted | Paid wrongly |
|---|---|---|---|---|---|---|
| iban_change | 49 | 89.8% | 5 | 0 | 0 | 0 |
| clean | 47 | 95.7% | 2 | 0 | 0 | 0 |
| qty_mismatch | 51 | 94.1% | 3 | 0 | 0 | 0 |
| no_po | 39 | 87.2% | 5 | 0 | 0 | 0 |
| qr_tamper | 46 | 97.8% | 1 | 0 | 0 | 0 |
| invalid_vat | 51 | 94.1% | 3 | 0 | 0 | 0 |
| vat_math | 34 | 94.1% | 2 | 0 | 0 | 0 |
| duplicate | 44 | 86.4% | 6 | 0 | 0 | 0 |
| several problems at once | 50 | 94.0% | 3 | 0 | 0 | 0 |
| over_limit | 48 | 95.8% | 2 | 0 | 0 | 0 |
| price_mismatch | 37 | 83.8% | 6 | 0 | 0 | 0 |
| missing_grn | 54 | 92.6% | 4 | 0 | 0 | 0 |

## B. Hard real-world cases

| Case | Invoices | Correct | To a person | Held | Misrouted | Paid wrongly |
|---|---|---|---|---|---|---|
| Bank account written with spaces (same account) | 20 | 100.0% | 0 | 0 | 0 | 0 |
| VAT rounded line by line (a few halalas off) | 20 | 0.0% | 0 | 20 | 0 | 0 |
| Order number written differently | 20 | 100.0% | 0 | 0 | 0 | 0 |
| Supplier uses its full legal name | 20 | 100.0% | 0 | 0 | 0 | 0 |
| Price 0.5% higher (inside the 1% tolerance) | 20 | 100.0% | 0 | 0 | 0 | 0 |
| Price 1.5% higher (just outside the tolerance) | 20 | 100.0% | 0 | 0 | 0 | 0 |
| One order billed in two parts | 40 | 100.0% | 0 | 0 | 0 | 0 |
| Large order split to stay under the approval limit | 40 | 5.0% | 0 | 0 | 0 | 38 |
| Same goods billed again under a new number and a new date | 20 | 100.0% | 0 | 0 | 0 | 0 |
| Monthly service: same amount, new order each month | 20 | 100.0% | 0 | 0 | 0 | 0 |
| Date written as day/month/year | 20 | 100.0% | 0 | 0 | 0 | 0 |
| Supplier genuinely changed bank (new account) | 20 | 100.0% | 0 | 0 | 0 | 0 |
| Impostor quotes a real order number | 20 | 80.0% | 0 | 0 | 4 | 0 |
| Amounts in European style (1.234,50) | 20 | 0.0% | 0 | 20 | 0 | 0 |
| Free-text email invoice | 20 | 0.0% | 20 | 0 | 0 | 0 |

### Why each case is hard, and what Wazin did when it got it wrong

- **Bank account written with spaces (same account).** Suppliers often print IBANs in groups of four. No misses.
- **VAT rounded line by line (a few halalas off).** Many billing systems round VAT on each line, so the total differs from 15% by 1–3 halalas. Example miss: expected APPROVED_AUTO, Wazin said EXCEPTION (VAT_CALC_ERROR).
- **Order number written differently.** People type "PO 2026-3001", "po-2026-3001" or add a full stop. No misses.
- **Supplier uses its full legal name.** The invoice says "… Co. Ltd" while the supplier list has the short name; the VAT number matches. No misses.
- **Price 0.5% higher (inside the 1% tolerance).** Small agreed variations should not stop payment. No misses.
- **Price 1.5% higher (just outside the tolerance).** A small overcharge that must still go to Procurement. No misses.
- **One order billed in two parts.** Suppliers often invoice part of an order now and the rest later. No misses.
- **Large order split to stay under the approval limit.** A SAR 60–90K order billed as two invoices under SAR 50K each. Policy: the order value needs a manager. Example miss: expected APPROVAL_REQUIRED, Wazin said APPROVED_AUTO.
- **Same goods billed again under a new number and a new date.** A classic duplicate: nothing extra was ordered or delivered. No misses.
- **Monthly service: same amount, new order each month.** Cleaning, security or rent look identical every month but are not duplicates. No misses.
- **Date written as day/month/year.** Common on printed invoices: 14/10/2026. No misses.
- **Supplier genuinely changed bank (new account).** Even when it is real, the policy is to block until Treasury phones the supplier. No misses.
- **Impostor quotes a real order number.** An unknown company with a valid-looking VAT number bills against a real order. Example miss: expected EXCEPTION, Wazin said BLOCKED (BANK_DETAILS_CHANGED).
- **Amounts in European style (1.234,50).** Some foreign suppliers swap the comma and the dot. Example miss: expected APPROVED_AUTO, Wazin said EXCEPTION (VAT_CALC_ERROR, QR_MISMATCH).
- **Free-text email invoice.** Written as a normal email; rules cannot read it, an AI model can. Example miss: expected APPROVED_AUTO, Wazin said REVIEW (EXTRACTION_INCOMPLETE).
