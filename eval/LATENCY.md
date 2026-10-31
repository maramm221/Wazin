# Speed (latency)

Run: `npm run latency` · 2026-10-31 · Node v22.23.4. Measured on the server itself; over the internet, network time is added.

| What | Runs | Average | Median | 95% of runs under |
|---|---|---|---|---|
| Agent decision (read, all checks, decide) | 300 invoices | 0.6 ms | 0.5 ms | 1.0 ms |
| Upload through the web server (sign-in check, decide, encrypt, save) | 50 | 3.2 ms | 3.0 ms | 4.4 ms |
| Dashboard | 20 | 2.3 ms | 2.1 ms | 5.0 ms |

Free-text emails read by an AI model add the model's response time (typically a few seconds) for those invoices only.
