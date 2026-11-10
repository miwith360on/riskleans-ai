# RiskLens AI

AI-powered unusual payment detection for small businesses.

## PayPal Sandbox API

The Express + TypeScript backend uses PayPal Sandbox server-side OAuth credentials. It only accepts `https://api-m.sandbox.paypal.com`; it cannot send these credentials to PayPal Live. Credentials stay in `server/.env` and are never returned by the API. New orders include PayPal return and cancellation URLs, configurable with `PAYPAL_RETURN_URL` and `PAYPAL_CANCEL_URL`. The defaults return the browser to the local dashboard after buyer approval or cancellation. For non-local deployments, configure HTTPS URLs you control.

### Local setup

Requires Node.js 22.12+ (or 20.19+) and npm.

1. Copy `server/.env.example` to `server/.env` only if you do not already have `server/.env`. Configure a random `DEMO_ACCESS_TOKEN` of at least 32 characters. For example, generate one locally with:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

   Put the generated value only in `server/.env`; never commit it, put it in a `VITE_*` variable, or share it in chat. Configure the PayPal **Sandbox** app client ID/secret and `OPENAI_API_KEY` in that same local file if you want to use those integrations. `OPENAI_MODEL` defaults to `gpt-5.4-mini`.
2. In a terminal, run:

   ```powershell
   cd server
   npm install
   npm run dev
   ```

   The backend binds to `127.0.0.1:3001` by default. `HOST` can be set for a deliberate deployment; production startup fails if `DEMO_ACCESS_TOKEN` is missing or shorter than 32 characters.
3. In a second terminal, run:

   ```powershell
   cd client
   npm install
   npm run dev
   ```

   Open `http://localhost:5173`, enter the same demo token in the dashboard's password field, and select **Connect**. The browser keeps the token in memory only; re-enter it after a reload. The dashboard sends it in the `Authorization: Bearer` header to protected endpoints. `VITE_API_BASE_URL` may be set at frontend build/start time if the API uses another base URL; never put the access token or provider keys in frontend environment variables.

### API endpoints

- `GET /api/health` — backend health check.
- `POST /api/paypal/orders` — protected by the demo access token. Creates a PayPal Sandbox order for the fixed $10.00 USD RiskLens test product.
- `POST /api/paypal/orders/:orderId/capture` — protected. Captures only an order created and registered by this backend process after PayPal confirms it is `APPROVED`. Unknown, ineligible, in-progress, or already-captured orders are rejected. Registration is in memory; after a backend restart, orders created before that restart cannot be captured through this process.
- `GET /api/paypal/captures` — protected. Reads configured Sandbox order IDs and returns only PayPal-verified completed captures without payer details.
- `POST /api/ai/investigate` — protected by the demo access token. Requests a structured AI review of a synthetic demo transaction. Only amount, simulated timing/count flags, and the deterministic score are sent to OpenAI; transaction IDs and customer names are not sent.

Protected requests require `Authorization: Bearer <your-local-demo-access-token>`. The health route is public and does not expose integration status or credentials.

## AI investigation setup

The backend calls OpenAI's Chat Completions API using the server-side `OPENAI_API_KEY` and defaults to `gpt-5.4-mini`; no additional SDK or package is required. The request uses low reasoning effort and strict JSON Schema output supported by this model. Create an OpenAI API project/key and configure its usage or billing limits before enabling requests. API usage is billed according to the selected model and token usage; pricing can change, so check OpenAI's current API pricing. No service is purchased or required to run the dashboard or tests.

Copy the placeholder `OPENAI_API_KEY` and `OPENAI_MODEL` entries from `server/.env.example` into your local `server/.env`, replace the key locally, then restart the backend. Never commit `server/.env`. The AI feature responds with a clear unavailable error until the key is configured; tests use mocked responses and do not call OpenAI.

AI request protection defaults to `AI_REQUESTS_PER_MINUTE=3` and `AI_MAX_REQUESTS=20`. The cap limits attempts per backend process lifetime, not dollars or exact spend. Limits are held in memory: a restart resets them, and multiple server instances each have their own limits. The backend also caps each completion at 1,200 tokens and times out provider requests after 30 seconds. Set lower limits if appropriate for a demo.

The **Investigate with AI** action is available only for fictional synthetic demo transactions. It cannot investigate or change PayPal Sandbox captures. AI output is advisory and cites only submitted demo evidence; the app's deterministic risk score remains authoritative for the displayed score and is not a fraud probability. Missing customer history, device details, and other unprovided information remain unknown.

The demo token is shared bearer access, not per-user identity or a production account system. Keep it private and use HTTPS outside local development. AI usage and the PayPal routes are protected, but the AI limits and order registry are process-local; use shared persistent storage and distributed rate limiting before running multiple production instances. Request caps are not spend guarantees.

Example PowerShell requests:

```powershell
Invoke-RestMethod http://localhost:3001/api/health
$headers = @{ Authorization = "Bearer <your-local-demo-access-token>" }
$order = Invoke-RestMethod -Method Post -Uri http://localhost:3001/api/paypal/orders -Headers $headers
$order
```

Open the returned `approvalUrl` and approve the order using a PayPal Sandbox buyer account. PayPal returns the browser to the configured return URL after approval. Buyer approval does not capture funds; capture an approved order separately:

```powershell
Invoke-RestMethod -Method Post -Uri "http://localhost:3001/api/paypal/orders/$($order.id)/capture" -Headers $headers
```

The API never sends credentials or OAuth access tokens to the browser. The dashboard keeps fictional risk-scored demo activity separate from PayPal Sandbox captures. It only displays PayPal-verified completed capture IDs, amounts, currencies, and statuses; it does not invent customer details or risk indicators for real Sandbox transactions.
