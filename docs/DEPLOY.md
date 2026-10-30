# Putting Wazin on the internet

Total time: about 15 minutes. You need a GitHub account and a free Render account (https://render.com, sign in with GitHub).

## 1. Put the code on GitHub

1. On github.com, click **New repository**. Name it `wazin`, set it to **Public**, and do **not** add a README (the code already has one). Click **Create repository**.
2. On your computer, open a terminal in the unzipped `wazin` folder and run (replace `YOUR-NAME`):

```bash
git remote add origin https://github.com/YOUR-NAME/wazin.git
git branch -M main
git push -u origin main
```

GitHub runs the 88 tests automatically on every push (the **Actions** tab shows a green tick).

## 2. Deploy on Render

1. In Render, click **New** → **Blueprint**.
2. Choose your `wazin` repository. Render reads `render.yaml` and shows one web service called **wazin**.
3. It asks for `ANTHROPIC_API_KEY`. Leave it empty unless you have one (then free-text email invoices are read by AI).
4. Click **Apply**. The first build takes 2–3 minutes.
5. Open the URL Render gives you, for example `https://wazin.onrender.com`. Sign in, or open a company account.

That URL is the working-application link for your submission.

Render generates `WAZIN_DATA_KEY`, the encryption key, automatically (a random 256-bit value). Never put it in the code or share it.

## 3. Before judging

- The free plan **sleeps after 15 minutes** without visitors and takes about a minute to wake. Open the link yourself a few minutes before anyone looks at it, or upgrade the service to a paid plan for the judging week.
- The free plan's disk is **temporary**. The reference company is rebuilt on every start, so it is unaffected. Real company workspaces would be lost on restart. For real use: choose a paid plan, uncomment the `disk` block in `render.yaml`, and set `WAZIN_DB=/var/data/wazin.db`.

## Settings (environment variables)

| Variable | Required | Meaning |
|---|---|---|
| `WAZIN_DATA_KEY` | yes in production | 32 random bytes, base64. Encrypts sensitive data. Create one with `npm run keygen`. Losing it makes encrypted data unreadable, so keep a backup in a password manager. |
| `NODE_ENV` | yes | `production` turns on Secure cookies, HSTS and trusts the host's proxy for client addresses. |
| `PORT` | no | Default 3000; hosts set it for you. |
| `WAZIN_DB` | no | Database file path. Default `var/wazin.db`. |
| `ANTHROPIC_API_KEY` | no | Turns on AI reading of free-text invoices. |
| `WAZIN_MODEL` | no | Model id for that reading. |
| `WAZIN_ALLOW_SIGNUP` | no | `0` hides "Create a company workspace". |
| `WAZIN_SEED_PASSWORD` | no | Opens the reference company "Sahara Trading Co." with one sign-in per team (see README). At least 10 characters. |
| `LOG_LEVEL` | no | `info` (default), `warn`, `error`. |

## Any other host (Docker)

```bash
docker build -t wazin .
docker run -p 3000:3000 -e WAZIN_DATA_KEY="$(npm run -s keygen)" -v wazin-data:/data wazin
```

For a Saudi company, choose hosting inside the Kingdom where possible. The Personal Data Protection Law (enforced by SDAIA since 14 September 2024) requires safeguards for personal data sent abroad.

## Backups

The whole state is one SQLite file plus the key. Back up both, separately: the file with your host's disk snapshots, the key in a password manager. Restoring is copying the file back and setting the same key.
