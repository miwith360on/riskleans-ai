# RiskLens AI

**Spot the unusual. Know what matters.**

RiskLens AI is a payment-risk dashboard for small business owners who take payments through PayPal. Big companies have fraud teams; a small shop owner has themselves. RiskLens flags payments worth a second look, shows exactly how every risk point was earned, and uses AI to explain each payment in plain English, so the owner can decide in seconds instead of guessing.

> Built for the PayPal AI Hackathon. Uses the PayPal Sandbox (no real money moves), OpenAI, and AG Grid.

- **Live demo:** `https://<your-app>.onrender.com` _(free hosting: the first load after a quiet period can take up to a minute)_
- **Demo access token:** provided in the Devpost testing instructions. Paste it into the top bar and select **Connect** to unlock PayPal and AI features.

---

## What it does

| Feature | How it works |
|---|---|
| **Real PayPal payments, scored** | Completed PayPal Sandbox captures are loaded from the PayPal Orders API and appear in the main table with a blue **PayPal Sandbox** badge, scored by the same rules as everything else. |
| **Transparent scoring** | Every score is the sum of visible points: a +5 baseline, then rules for large amounts, payment bursts, new customers and off-hours activity. Hover a score to see the math. Scores are capped at 100 and are not fraud probabilities. |
| **AI investigation of real PayPal data** | For a PayPal row, the browser sends only the capture ID. The server fetches the capture directly from PayPal (amount, status, capture time, seller protection, PayPal fee, net amount) and asks the AI to explain it for a merchant, citing only those PayPal-returned facts. |
| **Honest about missing data** | PayPal capture data has no payment history or customer tenure, so those rules are *not applied* rather than guessed. The AI is told the same. |
| **Review workflow** | Mark a payment reviewed; status is saved in the browser, and the "Needs review" count updates. |
| **AG Grid investigator** | Sorting, column filters, quick-filter search, a Source column, highlighted unreviewed high-risk rows, score tooltips and **Export CSV**. |
| **Demo data for context** | 12 clearly labeled fictional payments show how the rules behave across risk levels. |

## How PayPal and AI work together

```
Browser ──(capture ID only)──▶ RiskLens server ──▶ PayPal Sandbox API
                                     │              (GET /v2/payments/captures/:id)
                                     │
                                     ├─ scores the capture with the same rules
                                     │
                                     └──(PayPal facts only, no IDs or names)──▶ OpenAI
                                                                               │
Browser ◀──────── plain-English note + cited evidence + suggested human steps ─┘
```

Guardrails:

- The AI explains the deterministic score; it never changes it.
- Each AI observation must cite one exact evidence item, or the response is rejected.
- No transaction IDs, order IDs or customer names are sent to OpenAI.
- The AI suggests human review steps only. RiskLens never refunds, blocks or captures a payment.

## Tech stack

- **Frontend:** React + TypeScript (Vite), **AG Grid Community**
- **Backend:** Node.js + Express + TypeScript
- **PayPal:** Orders API v2 and Payments API v2 (Sandbox), server-side OAuth
- **AI:** OpenAI Chat Completions with strict JSON Schema output (`gpt-5.4-mini` by default)
- **Hosting:** Render (one web service serves both the API and the dashboard)

---

## Run it locally

Requires **Node.js 22.12+** (or 20.19+) and npm.

### 1. Configure the backend

Copy `server/.env.example` to `server/.env` and fill in:

| Variable | What it is |
|---|---|
| `DEMO_ACCESS_TOKEN` | A random password you make up (32+ characters). Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | From a **Sandbox** app at [developer.paypal.com](https://developer.paypal.com) → Apps & Credentials |
| `OPENAI_API_KEY` | From [platform.openai.com](https://platform.openai.com) (separate from a ChatGPT subscription) |
| `PAYPAL_CAPTURE_ORDER_IDS` | Optional comma-separated Sandbox order IDs to display |

Never commit `server/.env`; it is already in `.gitignore`.

### 2. Start both parts (two terminals)

```powershell
# Terminal 1 — backend (API, PayPal, AI) on port 3001
cd server
npm install
npm run dev
```

```powershell
# Terminal 2 — dashboard on port 5173
cd client
npm install
npm run dev
```

Open `http://localhost:5173`. In the top bar, paste **only the value after** `DEMO_ACCESS_TOKEN=` from `server/.env` and select **Connect**.

> If the page loads but AI or PayPal features fail, the backend (Terminal 1) is not running.

### 3. Try it

1. Click **PayPal Sandbox** in the sidebar and select the blue-badged row.
2. Read **How the score adds up** in the details panel.
3. Select **Investigate with AI**.
4. Select **Mark transaction reviewed**.

### Tests

```powershell
cd server
npm test
npm run typecheck
```

---

## Deploy to Render

The repo includes `render.yaml`. On [render.com](https://render.com): **New → Blueprint**, pick this repository, then fill in the secret values it asks for (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `OPENAI_API_KEY`, and `PAYPAL_RETURN_URL` / `PAYPAL_CANCEL_URL` as `https://<your-app>.onrender.com/?paypal=return` and `?paypal=cancel`). Render generates `DEMO_ACCESS_TOKEN`; copy it from the service's **Environment** tab.

Manual setup instead of a Blueprint:

- **Build command:** `cd client && npm ci --include=dev && npm run build && cd ../server && npm ci --include=dev`
- **Start command:** `cd server && npm start`
- **Environment:** `NODE_VERSION=22`, `NODE_ENV=production`, `HOST=0.0.0.0`, plus the variables above.

---

## API reference

All routes except health require `Authorization: Bearer <DEMO_ACCESS_TOKEN>`.

| Route | Purpose |
|---|---|
| `GET /api/health` | Health check (public; reveals no configuration). |
| `GET /api/paypal/captures` | PayPal-verified completed captures for the configured Sandbox orders, without payer details. |
| `POST /api/paypal/orders` | Creates a $10.00 USD Sandbox order and returns its approval URL. |
| `POST /api/paypal/orders/:orderId/capture` | Captures an approved order created by this server process. |
| `POST /api/ai/investigate` | AI investigation. Body `{ "source": "paypal_sandbox", "transactionId": "<capture id>" }` for PayPal captures (server fetches the facts from PayPal), or a demo transaction with its evidence. |

## Limits and safety

- The PayPal client only talks to `api-m.sandbox.paypal.com`; it cannot reach PayPal Live.
- Credentials and OAuth tokens never reach the browser.
- AI requests are rate limited (`AI_REQUESTS_PER_MINUTE`, `AI_MAX_REQUESTS`) per server process; restarts reset the counters. These limit attempts, not exact spend.
- The demo token is shared access for judging, not a user account system.
- Risk scores come from four illustrative rules and are **not** validated fraud probabilities. AI output is advisory.

## License

[MIT](LICENSE)
