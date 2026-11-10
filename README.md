# RiskLens AI

AI-powered unusual payment detection for small businesses.

## PayPal Sandbox API

The Express + TypeScript backend uses PayPal Sandbox server-side OAuth credentials. It only accepts `https://api-m.sandbox.paypal.com`; it cannot send these credentials to PayPal Live. Credentials stay in `server/.env` and are never returned by the API. New orders include PayPal return and cancellation URLs, configurable with `PAYPAL_RETURN_URL` and `PAYPAL_CANCEL_URL`. The defaults return the browser to the local dashboard after buyer approval or cancellation. For non-local deployments, configure HTTPS URLs you control.

### Local setup

1. Copy `server/.env.example` to `server/.env` only if you do not already have `server/.env`. Add your PayPal **Sandbox** app client ID and secret to the local file. Never commit or share it. To enable AI investigations, configure `OPENAI_API_KEY` in the same local file; `OPENAI_MODEL` defaults to `gpt-5.4-mini`.
2. In a terminal, run:

   ```powershell
   cd server
   npm install
   npm run dev
   ```

   The backend listens on `http://localhost:3001` by default.
3. Keep the existing React dashboard running separately on `http://localhost:5173`. It reads verified capture data from `http://localhost:3001`; set `VITE_API_BASE_URL` before starting Vite if the backend uses another base URL.

### API endpoints

- `GET /api/health` — backend health check.
- `POST /api/paypal/orders` — creates a PayPal Sandbox order for the fixed $10.00 USD RiskLens test product. Returns an order ID, status, and Sandbox approval URL.
- `POST /api/paypal/orders/:orderId/capture` — captures an approved order. The order ID is validated; successful duplicate requests in this server process return the cached result instead of sending another capture request.
- `GET /api/paypal/captures` — reads the configured Sandbox order IDs from PayPal and returns only captures whose PayPal status is `COMPLETED`. The default list includes the existing RiskLens $10 Sandbox order; optionally set `PAYPAL_CAPTURE_ORDER_IDS` to a comma-separated list of order IDs to monitor. Customer and payer details are not returned.

`POST /api/ai/investigate` requests a structured AI review of a synthetic demo transaction. Only amount, simulated timing/count flags, and the existing deterministic score are sent to OpenAI; transaction IDs and customer names are not sent. Without `OPENAI_API_KEY`, the endpoint returns `503 ai_not_configured`.

## AI investigation setup

The backend calls OpenAI's Chat Completions API using the server-side `OPENAI_API_KEY` and defaults to `gpt-5.4-mini`; no additional SDK or package is required. The request uses low reasoning effort and strict JSON Schema output supported by this model. Create an OpenAI API project/key and configure its usage or billing limits before enabling requests. API usage is billed according to the selected model and token usage; pricing can change, so check OpenAI's current API pricing. No service is purchased or required to run the dashboard or tests.

Copy the placeholder `OPENAI_API_KEY` and `OPENAI_MODEL` entries from `server/.env.example` into your local `server/.env`, replace the key locally, then restart the backend. Never commit `server/.env`. The AI feature responds with a clear unavailable error until the key is configured; tests use mocked responses and do not call OpenAI.

The **Investigate with AI** action is available only for fictional synthetic demo transactions. It cannot investigate or change PayPal Sandbox captures. AI output is advisory and cites only submitted demo evidence; the app's deterministic risk score remains authoritative for the displayed score and is not a fraud probability. Missing customer history, device details, and other unprovided information remain unknown.

The current dashboard is a local hackathon prototype. CORS is not authentication; before exposing the backend publicly, add authentication and server-side request rate limits to protect the AI key and provider budget.

Example PowerShell requests:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
$order = Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/paypal/orders
$order
```

Open the returned `approvalUrl` and approve the order using a PayPal Sandbox buyer account. PayPal returns the browser to the configured return URL after approval. Buyer approval does not capture funds; capture an approved order separately:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3001/api/paypal/orders/$($order.id)/capture"
```

The API never sends credentials or OAuth access tokens to the browser. The dashboard keeps fictional risk-scored demo activity separate from PayPal Sandbox captures. It only displays PayPal-verified completed capture IDs, amounts, currencies, and statuses; it does not invent customer details or risk indicators for real Sandbox transactions.
