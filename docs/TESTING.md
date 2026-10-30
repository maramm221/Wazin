# Tests

All tests are in the `test/` folder and run with Node's built-in test runner. No installs.

```bash
npm test
```

Expected ending:

```
# tests 88
# pass 88
# fail 0
```

GitHub runs the same command on every push (`.github/workflows/ci.yml`).

## What each file checks

| File | Tests | What it proves |
|---|---|---|
| `test/zatca.test.js` | 8 | VAT-number rule BR-KSA-40; QR code encoding byte by byte, including Arabic names; 15% VAT maths; QR tampering detection |
| `test/extract.test.js` | 11 | Reading ZATCA XML, bilingual text and Arabic-only invoices with Arabic digits; AI used only for free text, called once, and failures handled safely; messy inputs (line breaks, spacing, Arabic-Indic digits, field order, lower-case labels, minified XML) read the same |
| `test/agent.test.js` | 17 | Every decision: automatic payment, approval, duplicate, re-billing under a new number and date, bank-account change, supplier errors, overcharges, short deliveries, waiting for goods, several problems at once |
| `test/benchmark.test.js` | 3 | The 300-invoice benchmark stays at ≥99% with zero wrong payments; the generator is repeatable |
| `test/api.test.js` | 36 | A real server and database: the reference company, company set-up (two-way matching, one-person companies, validation), each role's tasks, approve, goods receipt, bank verification, order amendment, rejection, manual entry, CSRF, origin check, role limits, session cookies, sign-up, imports, teammates, lock-out, rate limits, logout, bad input, path traversal, script injection, SQL characters, encryption in the database file, tampering with the activity log |
| `test/security.test.js` | 8 | AES-256-GCM (fresh IV, bound to company and field, tamper detection, wrong key), password hashing and policy, CSV parsing and formula-safe export |
| `test/i18n.test.js` | 5 | Every screen text exists in Arabic and English; every error the server can send has a message in both |

Run one file: `node --test test/api.test.js`

## Benchmark and stress test

```bash
npm run eval      # writes eval/RESULTS.md and eval/results.json
npm run stress    # writes eval/STRESS.md
```

The benchmark generates 300 Saudi supplier invoices in four formats with ten kinds of known problems, runs Wazin on them, and scores every decision against the known answer. The stress test repeats this with ten different random seeds and puts two or three problems on 30% of invoices.

## Held-out evaluation (`npm run heldout`)

Results in [`eval/HELDOUT.md`](../eval/HELDOUT.md). Nothing in it was used while building or tuning the rules.

1. **Unseen seeds:** 5 × 300 invoices from random seeds never used in development (development used 2026 and 1–10).
2. **Unseen suppliers:** 6 new suppliers with their own names, VAT numbers, bank accounts, products and payment terms; once with one problem per invoice and once with 2–3 problems at once.
3. **Messy inputs:** the same invoices rewritten the way real documents arrive: Windows line breaks, extra spacing, Arabic-Indic digits, header fields in another order, lower-case labels, minified XML, no thousands separators, and all of them at once.
4. **Ablation:** each check (ZATCA, bank account, duplicates, order and delivery match) switched off in turn, to measure how many wrong payments it prevents.
5. **Adaptation:** the company's settings changed (two-way matching, 20% price tolerance) and the decisions checked against the new expected outcome.

The two messy-input tests in `test/extract.test.js` keep these cases from breaking again (regression checks).

## Trying it by hand

`WAZIN_SEED_PASSWORD="choose-a-password-1" npm start`, open http://localhost:3000 and sign in as each team (`ap@sahara.example`, `treasury@sahara.example` and so on; see the README).
