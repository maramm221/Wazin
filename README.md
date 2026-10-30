# Wazin · وازِن

**An AI agent that owns your supplier invoices.** Wazin reads every invoice, checks it against Saudi ZATCA e-invoicing rules, the purchase order and what actually arrived, and then either schedules the payment or sends the exact problem to the one team that can fix it, with a ready-to-send message in Arabic and English.

HUMAIN Future AI Builders Hackathon 2026 · **Challenge 3: Autonomous Enterprise** · Built by Maram Talib

*Wazin (وازِن) means "the one who weighs": it weighs every invoice against the order and the delivery before any money moves.*

---

## What it is

A **web application** (software as a service). People use it in a browser on a computer or phone; nothing to install. Each company gets its own private **workspace**, with its own suppliers, purchase orders, invoices and team. It is a private B2B service a company would subscribe to, not a government platform. (A `.gov.sa` address is only for government bodies; a ministry could still use Wazin for its own supplier invoices.)

| Who | What they do in Wazin |
|---|---|
| Accounts Payable | Upload invoices, fix unreadable ones, send supplier corrections |
| Finance Manager | Approve invoices above the automatic limit |
| Procurement | Settle price differences: amend the order or reject the invoice |
| Warehouse | Record what actually arrived |
| Treasury | Verify bank-account changes by call-back; manage supplier bank details |
| Administrator | Import data, add people, set the approval limit |

Each person sees **their own tasks** on the home page, with numbered steps for what to do next.

## What Wazin decides

| Finding | Wazin does | Hands to |
|---|---|---|
| Everything matches, up to the limit (default SAR 50,000) | Posts to the ledger, schedules payment, takes any early-payment discount | No one |
| Everything matches, above the limit | Asks for one-click approval | Finance Manager |
| Goods not received yet | Waits; when the warehouse records the delivery, checks again and pays by itself | Warehouse |
| Wrong VAT number, VAT maths or QR code | Drafts a correction request to the supplier | Accounts Payable → Supplier |
| Price above the order, item not on the order, unknown order or supplier | Shows the overcharge, offers "amend order" or "reject" | Procurement |
| Billed more than arrived | Asks for the true received quantity | Warehouse |
| New bank account on the invoice | **Blocks payment** until Treasury confirms by calling the number on file | Treasury |
| Duplicate, or the same goods billed again under a new number and date | **Blocks payment** | Accounts Payable |

## Run it on your computer

You need **Node.js 22.13 or newer** (https://nodejs.org). No other installs, no database server.

```bash
cd wazin
npm start            # open http://localhost:3000 and press "Try the live demo"
npm test             # 82 automated tests
npm run eval         # 300-invoice benchmark  -> eval/RESULTS.md
npm run stress       # 3,000-invoice stress test -> eval/STRESS.md
npm run demo         # the 13-invoice demo in the terminal, no browser
```

On first start Wazin creates a development encryption key in `var/dev.key` and a database in `var/wazin.db`. In production the key must come from the environment (see [docs/DEPLOY.md](docs/DEPLOY.md)).

Optional: set `ANTHROPIC_API_KEY` and Wazin also reads free-text invoices (emails, OCR text) with AI. Without it, those invoices go to Accounts Payable to type in.

## Put it on the internet

See **[docs/DEPLOY.md](docs/DEPLOY.md)**: push to GitHub, then one Render Blueprint (≈10 minutes, free plan). A Dockerfile is included for any other host.

## Security and data protection

See **[docs/SECURITY.md](docs/SECURITY.md)**. In short:

- **Sign-in:** passwords hashed with scrypt; sessions in HttpOnly, SameSite=Strict, Secure cookies; 12-hour sessions; accounts lock for 15 minutes after 5 wrong passwords; sign-in rate limited.
- **Every change is protected:** per-session CSRF token plus an origin check.
- **Roles:** the server checks the role on every action; a warehouse user cannot approve a payment, and only Treasury can see or change a full bank account.
- **Encryption at rest:** supplier bank accounts, phones, emails, every invoice document, every result and every log detail are encrypted with AES-256-GCM, bound to the company and the field.
- **Tamper-evident activity log:** each entry includes the hash of the previous one; any later edit is detected and shown.
- **Hardened web layer:** strict Content-Security-Policy, no inline scripts, all user data inserted as text; size limits, rate limits, safe CSV export.
- **Logs:** structured JSON lines; no request bodies, cookies, passwords or bank details are ever logged.

## How it is built

```
public/     the web app: plain JavaScript, Arabic/English, mobile first, no build step
server/     HTTP layer, sessions, roles, encryption, SQLite storage, audit chain
src/        the agent: reading, ZATCA checks, three-way match, decisions, messages
data/       the demo company and the labelled benchmark generator
eval/       benchmark and stress test
test/       82 automated tests
```

**Where the AI is, and where it is not.** ZATCA XML e-invoices and labelled Arabic or English text are read directly, with zero AI tokens, in under a millisecond. Only free text (an email, OCR output) goes to a language model, once. The model never decides whether to pay: every number it extracts goes through the same rules, so a wrong figure is caught, not paid. On the 300-invoice benchmark this used about 18,500 tokens instead of an estimated 2 million for an agent that calls a model at every step.

**Zero runtime dependencies.** Node's built-in `http`, `crypto` and `sqlite`. Nothing to patch from third parties.

## Measured results

| | Result |
|---|---|
| Automated tests | **82 / 82 passing** (`npm test`) |
| Correct decision, 300 labelled invoices | **100%** of the 272 read without AI |
| Invoices paid that should not have been | **0** |
| Stress test: 3,000 invoices, 622 with 2–3 problems at once | **100% correct, 0 false payments** |
| Waiting invoices cleared automatically when goods arrived | **13 / 13** |
| Money stopped (duplicates, fraud, overcharges) | **SAR 364,383** |

The benchmark data is synthetic and labelled, so it proves the rules and routing are exact. Reading accuracy on real scanned invoices is the first thing a pilot would measure.

## Limits, said plainly

- The QR check covers the 5 core ZATCA tags. Verifying the 4 Phase 2 signature tags needs the supplier's certificate chain: next step.
- VAT numbers are checked for format (rule BR-KSA-40), not live registration with ZATCA.
- PDF invoices: paste their text or upload the XML; reading PDF files directly is next.
- One server instance with SQLite handles thousands of invoices a day. To run several instances, move storage to PostgreSQL and rate limits to Redis; the storage layer is isolated in `server/store.js` for that.

Sources for every fact: [docs/SOURCES.md](docs/SOURCES.md). Demo suppliers, orders and bank accounts are fictional; the rules are real.

MIT licence. © 2026 Maram Talib.
