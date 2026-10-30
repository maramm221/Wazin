# Security and data protection

Wazin handles supplier bank accounts and payments, so it is built to fail closed: when in doubt, it blocks a payment and asks a person.

## Accounts and sessions
| Control | How |
|---|---|
| Password storage | scrypt (N=16384, r=8, p=1), random 16-byte salt per user, constant-time comparison |
| Password policy | 10–200 characters, at least one letter and one digit |
| Brute force | 5 wrong passwords lock the account for 15 minutes; 10 sign-in attempts per minute per address |
| Account discovery | Unknown emails get the same error and the same hashing time as wrong passwords |
| Sessions | 32 random bytes, stored only as a SHA-256 hash; cookie is HttpOnly, SameSite=Strict, Secure in production; 12-hour lifetime; ended on sign-out and on password change |
| CSRF | Every state change needs the per-session token in a header, plus a same-origin check |
| New teammates | The administrator creates the account; a one-time temporary password is shown once |

## Authorisation
The server checks the role on **every** request. The interface hides buttons a role cannot use, but that is convenience only.
- Only the Finance Manager (or admin) approves invoices above the limit.
- Only Treasury sees full bank accounts; everyone else sees `•••• 1234`. Only Treasury can change one.
- Changing a bank account from an invoice needs a ticked call-back confirmation and a written reason, and is logged.
- Every company's data is separated by its workspace id in every query; asking for another company's invoice returns "not found".

## Data at rest
- AES-256-GCM with a random 96-bit IV per value. Key from `WAZIN_DATA_KEY`, never stored with the data.
- Encrypted: supplier IBANs, phones and emails; every invoice document; every check result; every activity-log detail.
- Each ciphertext is bound to its company and field (authenticated data), so a value copied to another row or company does not decrypt.
- Not encrypted, so the database can search and sort: invoice numbers, supplier names and VAT numbers (printed on every public tax invoice), totals and statuses.

## Data in transit
HTTPS from the host; `Strict-Transport-Security` in production.

## Activity log
Append-only and hash-chained: each entry stores SHA-256 of the previous entry and its own content. The Activity log page re-verifies the whole chain on every view and shows the first broken entry if anything was edited, deleted or reordered (tested in `test/api.test.js`).

## Web application
- Content-Security-Policy: scripts only from Wazin itself, no inline scripts, no framing (`frame-ancestors 'none'`), no plugins.
- All user and invoice data is inserted into the page as text (`textContent`), never as HTML.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Permissions-Policy` denies camera, microphone, location and payment.
- Request bodies limited to 1 MB, invoices to 500 KB, CSV imports to 2 MB; JSON only.
- Invoice XML is read with fixed patterns, not an XML parser, so XML entity attacks (XXE, billion laughs) do not apply.
- SQL uses prepared statements only; search text is escaped.
- CSV export neutralises spreadsheet formulas (`=`, `+`, `-`, `@`).
- Static files cannot be read outside the `public` folder.

## Logging and monitoring
- One JSON line per request: time, request id, method, path, status, duration, user id, workspace id.
- Never logged: request bodies, cookies, passwords, tokens, bank accounts, invoice contents.
- Unexpected errors are logged with the request id; the user sees "Something went wrong" and the same id.
- `/healthz` for uptime checks.

## AI
- The AI model only extracts fields from free text. It cannot approve, pay, or change data.
- Everything it returns is re-checked by the same rules as any other invoice.
- Off unless `ANTHROPIC_API_KEY` is set. When on, only the text of free-text invoices is sent.

## Saudi requirements to plan for in production
- **Personal Data Protection Law (PDPL)**, enforced by SDAIA since 14 September 2024: host in the Kingdom where possible, or use the approved safeguards for transfers abroad; keep a record of processing; set a retention period.
- **NCA Essential Cybersecurity Controls** for organisations that must follow them.
- Key management: move `WAZIN_DATA_KEY` to the host's secret manager or a KMS and rotate it yearly.

## Known limits
- No two-factor sign-in yet (next on the list).
- Rate limits are per server instance; with several instances, move them to Redis.
- Demo companies are public by design and deleted after 24 hours.
