# Tests

All tests are in the `test/` folder and run with Node's built-in test runner. No installs.

```bash
npm test
```

Expected ending:

```
# tests 82
# pass 82
# fail 0
```

GitHub runs the same command on every push (`.github/workflows/ci.yml`).

## What each file checks

| File | Tests | What it proves |
|---|---|---|
| `test/zatca.test.js` | 8 | VAT-number rule BR-KSA-40; QR code encoding byte by byte, including Arabic names; 15% VAT maths; QR tampering detection |
| `test/extract.test.js` | 9 | Reading ZATCA XML, bilingual text and Arabic-only invoices with Arabic digits; AI used only for free text, called once, and failures handled safely |
| `test/agent.test.js` | 17 | Every decision: automatic payment, approval, duplicate, re-billing under a new number and date, bank-account change, supplier errors, overcharges, short deliveries, waiting for goods, several problems at once |
| `test/benchmark.test.js` | 3 | The 300-invoice benchmark stays at ≥99% with zero wrong payments; the generator is repeatable |
| `test/api.test.js` | 32 | A real server and database: demo company, each role's tasks, approve, goods receipt, bank verification, order amendment, rejection, manual entry, CSRF, origin check, role limits, session cookies, sign-up, imports, teammates, lock-out, rate limits, logout, bad input, path traversal, script injection, SQL characters, encryption in the database file, tampering with the activity log |
| `test/security.test.js` | 8 | AES-256-GCM (fresh IV, bound to company and field, tamper detection, wrong key), password hashing and policy, CSV parsing and formula-safe export |
| `test/i18n.test.js` | 5 | Every screen text exists in Arabic and English; every error the server can send has a message in both |

Run one file: `node --test test/api.test.js`

## Benchmark and stress test

```bash
npm run eval      # writes eval/RESULTS.md and eval/results.json
npm run stress    # writes eval/STRESS.md
```

The benchmark generates 300 Saudi supplier invoices in four formats with ten kinds of known problems, runs Wazin on them, and scores every decision against the known answer. The stress test repeats this with ten different random seeds and puts two or three problems on 30% of invoices.

## Trying it by hand

`npm start`, open http://localhost:3000, press **Try the live demo**, and use **Viewing as** at the top to act as each team.
