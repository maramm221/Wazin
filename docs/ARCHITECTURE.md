# How Wazin is built

This page is for developers who want to read, change or extend the code. For running it, see the [README](../README.md); for deployment, [DEPLOY.md](DEPLOY.md); for security, [SECURITY.md](SECURITY.md); for tests, [TESTING.md](TESTING.md).

## The big picture

```
 browser (public/)                server (server/)                         agent (src/)
 ─────────────────                ─────────────────                        ────────────
 app.js  ── fetch JSON ──▶  app.js      routes, sessions, CSRF,
 i18n.js                          rate limits, security headers
 app.css                     │
                             ▼
                          service.js  business operations, roles ──▶  agent.js  WazinAgent.process(doc)
                             │                                          │  extract.js  read the invoice (3 tiers)
                             ▼                                          │  zatca.js    ZATCA rules
                          store.js    one company's data, encrypted     │  match.js    three-way match
                          db.js       SQLite schema and migrations      ▼
                          crypto.js   AES-256-GCM, scrypt, tokens     decision + owner + message + ledger entry
```

Three layers, each testable on its own:

| Layer | Folder | Knows about HTTP? | Knows about the database? |
|---|---|---|---|
| Agent | `src/` | No | No. It talks to an ERP adapter with a fixed interface. |
| Service | `server/service.js`, `server/store.js` | No | Yes, through `Store` only |
| Web | `server/app.js`, `public/` | Yes | No |

The agent is the same code in the web app, the command-line demo (`cli.js`), the benchmark (`eval/`) and the unit tests. Only the ERP adapter changes: `src/erp.js` (in memory) or `SqlERP` in `server/store.js` (SQLite).

## What happens to one invoice

1. **Arrives.** `POST /api/invoices` (upload or paste) → `Service.processNew`. A per-company lock makes sure two invoices from the same company are never decided at the same time, so duplicates cannot slip through in parallel.
2. **Read** (`src/extract.js`), cheapest first:
   - Tier 1: ZATCA UBL 2.1 XML → `parseUBL`. No AI.
   - Tier 2: labelled Arabic or English text → `parseText`. Arabic-Indic digits are normalised. No AI.
   - Tier 3: free text (email, OCR) → one language-model call, only if `ANTHROPIC_API_KEY` is set. The reply is parsed by `parseLLMJson` and then checked by the same rules as everything else.
   - Still incomplete → the invoice goes to Accounts Payable to type in (`manual_entry`).
3. **Check** (`src/zatca.js`, `src/match.js`, `src/agent.js`): VAT number (BR-KSA-40), 15% VAT maths, QR code totals, known supplier, verified bank account, duplicate fingerprint, already-invoiced quantities, price and quantity against the purchase order and goods receipts.
4. **Decide** (`WazinAgent.process`), riskiest finding first:

   | Priority | Finding | Decision | Owner |
   |---|---|---|---|
   | 1 | Duplicate, or the same goods billed again | Blocked | Accounts Payable |
   | 2 | New bank account | Blocked | Treasury |
   | 3 | Unknown supplier | Exception | Procurement |
   | 4 | ZATCA format or maths problem | Exception | Supplier (via AP) |
   | 5 | Unknown order, price above the order, item not on the order | Exception | Procurement |
   | 6 | Billed more than received | Exception | Warehouse |
   | 7 | Goods not received yet | Parked | Warehouse |
   | 8 | Everything matches, above the approval limit | Approval required | Finance Manager |
   | 9 | Everything matches | Approved and scheduled | none |

5. **Act.** The service saves the result, posts to the ledger if approved, and writes an audit entry, all in one database transaction.
6. **Follow up.** When a team acts (`Service.act`: approve, verify bank, amend order, record receipt, resubmit, …) the invoice is processed again from step 2 with the new facts. Recording a goods receipt re-checks every invoice parked on that order.

## Data model (`server/db.js`)

| Table | Holds | Encrypted columns |
|---|---|---|
| `orgs` | One row per company: name, approval limit | none |
| `users` | People, their role and scrypt password hash | none (hash only) |
| `sessions` | SHA-256 of each session token, CSRF token, expiry | none (hash only) |
| `vendors` | Suppliers, VAT number, verified bank account, contacts | bank account, phone, email |
| `purchase_orders` | Orders and their lines | none |
| `goods_receipts` | What the warehouse recorded | none |
| `invoices` | Original document, agent result, history, status, owner | document, result and history |
| `ledger` | Approved invoices and payment dates | none |
| `audit` | Hash-chained activity log | details |

Every query is scoped by `org_id`; `Store` methods take the company id as their first argument, so one company can never read another's rows. Encrypted values use the company id and field name as additional authenticated data, so a value copied to another company or column fails to decrypt.

## Roles (`server/service.js`)

`can(user, ...roles)` allows the listed roles, and always the administrator. That is why a one-person company works: the person who opens the account is the administrator and can do every step. Larger companies add people with narrower roles in Settings.

## Company settings (`orgs.settings_json`)

Each company chooses a few things in **Settings → How your company works**. Defaults are in `DEFAULT_SETTINGS` (`server/store.js`); the service validates every change (`cleanSettings` in `server/service.js`).

| Setting | Options | Effect |
|---|---|---|
| Who handles invoices | Just me, or the teams you have (Finance Manager, Procurement, Warehouse, Treasury) | A task for a team the company does not have goes to the administrator; the web app hides those teams. New companies start as "Just me". |
| Matching | Three-way (order and goods received) or two-way (order only) | Two-way treats everything ordered as received, so no invoice waits for a delivery; used for services. |
| Allowed price difference | 0 to 10% (default 1%) | Prices up to this much above the order are accepted. |
| Early-payment discounts | On or off | When off, Wazin pays on the normal due date. |

The agent reads them through the ERP adapter's optional `policy()` method, so the in-memory ERP used by the benchmark keeps the defaults.

## The web app (`public/`)

- No framework and no build step: plain ES modules served as they are.
- `h()` builds every element and inserts user data with `textContent` only, so data can never run as script. The strict Content-Security-Policy in `server/app.js` blocks inline scripts as a second line of defence.
- `i18n.js` holds every string in English and Arabic; `test/i18n.test.js` fails if a key is missing in either language. Layout uses CSS logical properties, so right-to-left works without separate styles.
- Hash routes (`#/home`, `#/invoice/WZN-00006`, …) keep the server simple: it serves one `index.html` and a JSON API.

## Adding a new check

1. Write the rule as a small pure function (for example in `src/zatca.js`) that returns issue objects `{ code, message, messageAr }`.
2. Call it from `WazinAgent.process` and decide where its code sits in the priority table above.
3. Add the step name and owner text in `src/agent.js` (both languages) and, if a person must act, an action in `Service.act`.
4. Add a unit test in `test/agent.test.js` and a labelled defect in `data/generate.js` so the benchmark measures it.
5. Run `npm test` and `npm run eval`.

## Conventions

- Node 22 built-ins only; no runtime dependencies to audit or patch.
- Every file starts with a comment saying what it is for; exported functions carry a one-line doc comment.
- Money is rounded with `round2` and compared with a tolerance, never with `===` on floats.
- Errors that reach the browser are `AppError(status, code)`; the web app shows the matching `e_<code>` message in the user's language.
