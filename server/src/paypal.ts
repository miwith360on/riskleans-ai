import { Router, type Request, type Response } from 'express'

const router = Router()
const orderIdPattern = /^[A-Z0-9]{1,64}$/i
const maxCachedCaptures = 500
const defaultCaptureOrderIds = ['25H57639MT004512P']

type PayPalOrder = {
  id: string
  status: string
  links?: Array<{ rel?: string; href?: string }>
}

type CaptureResult = {
  id: string
  status: string
  captures: Array<{
    id: string
    status: string
    amount?: { currencyCode: string; value: string }
  }>
}

type VerifiedSandboxCapture = {
  orderId: string
  transactionId: string
  status: 'COMPLETED'
  amount: string
  currency: string
}

class PayPalApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly issue?: string,
  ) {
    super('PayPal API request failed')
  }
}

let cachedToken: { value: string; expiresAt: number } | undefined
let tokenRequest: Promise<string> | undefined
const captureRequests = new Map<string, Promise<CaptureResult>>()

function getPayPalBaseUrl(): URL {
  const configuredUrl = process.env.PAYPAL_BASE_URL
  if (!configuredUrl) {
    throw new Error('PayPal Sandbox configuration is missing')
  }

  const url = new URL(configuredUrl)
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api-m.sandbox.paypal.com' ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash
  ) {
    throw new Error('PayPal API must use the PayPal Sandbox host')
  }

  return url
}

function getCredentials() {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim()
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    throw new Error('PayPal Sandbox credentials are missing')
  }

  return { clientId, clientSecret }
}

function getCheckoutRedirectUrl(
  name: 'PAYPAL_RETURN_URL' | 'PAYPAL_CANCEL_URL',
  defaultUrl: string,
): string {
  const url = new URL(process.env[name] || defaultUrl)
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')

  if (
    (url.protocol !== 'https:' && !isLocalHttp) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS URL (HTTP is allowed for localhost development)`)
  }

  return url.toString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.value
  }
  if (tokenRequest) {
    return tokenRequest
  }

  tokenRequest = requestAccessToken()
  try {
    return await tokenRequest
  } finally {
    tokenRequest = undefined
  }
}

async function requestAccessToken(): Promise<string> {
  const baseUrl = getPayPalBaseUrl()
  const { clientId, clientSecret } = getCredentials()
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const response = await fetch(new URL('/v1/oauth2/token', baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10_000),
  })
  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    throw new PayPalApiError(response.status)
  }
  if (
    !isRecord(payload) ||
    typeof payload.access_token !== 'string' ||
    typeof payload.expires_in !== 'number' ||
    !Number.isFinite(payload.expires_in)
  ) {
    throw new Error('PayPal returned an invalid OAuth response')
  }

  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + payload.expires_in * 1000,
  }
  return cachedToken.value
}

async function paypalRequest<T>(
  path: string,
  method: 'GET' | 'POST',
  body?: Record<string, unknown>,
): Promise<T> {
  const baseUrl = getPayPalBaseUrl()
  const accessToken = await getAccessToken()
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  const payload: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    let issue: string | undefined
    if (isRecord(payload) && Array.isArray(payload.details)) {
      const detail = payload.details.find(isRecord)
      if (detail && typeof detail.issue === 'string') {
        issue = detail.issue
      }
    }
    throw new PayPalApiError(response.status, issue)
  }
  if (!isRecord(payload)) {
    throw new Error('PayPal returned an invalid API response')
  }

  return payload as T
}

function sendPayPalError(res: Response, error: unknown) {
  if (error instanceof PayPalApiError) {
    if (error.issue === 'ORDER_ALREADY_CAPTURED') {
      res.status(409).json({ error: 'order_already_captured' })
      return
    }
    if (error.statusCode === 429) {
      res.status(503).json({ error: 'paypal_temporarily_unavailable' })
      return
    }
  }

  res.status(502).json({ error: 'paypal_request_failed' })
}

function findApprovalUrl(order: PayPalOrder): string | undefined {
  for (const relation of ['payer-action', 'approve']) {
    for (const link of order.links ?? []) {
      if (link.rel !== relation || typeof link.href !== 'string') {
        continue
      }

      try {
        const url = new URL(link.href)
        if (
          url.protocol === 'https:' &&
          (url.hostname === 'sandbox.paypal.com' || url.hostname.endsWith('.sandbox.paypal.com'))
        ) {
          return url.toString()
        }
      } catch {
        continue
      }
    }
  }

  return undefined
}

router.post('/orders', async (_req: Request, res: Response) => {
  try {
    const order = await paypalRequest<PayPalOrder>('/v2/checkout/orders', 'POST', {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: 'risklens-sandbox-test',
          description: 'RiskLens AI Sandbox Test Product',
          amount: { currency_code: 'USD', value: '10.00' },
        },
      ],
      application_context: {
        return_url: getCheckoutRedirectUrl(
          'PAYPAL_RETURN_URL',
          'http://localhost:5173/?paypal=return',
        ),
        cancel_url: getCheckoutRedirectUrl(
          'PAYPAL_CANCEL_URL',
          'http://localhost:5173/?paypal=cancel',
        ),
        user_action: 'PAY_NOW',
      },
    })

    const approvalUrl = findApprovalUrl(order)
    if (
      typeof order.id !== 'string' ||
      !orderIdPattern.test(order.id) ||
      typeof order.status !== 'string' ||
      !approvalUrl
    ) {
      throw new Error('PayPal returned an invalid order response')
    }

    res.status(201).json({ id: order.id, status: order.status, approvalUrl })
  } catch (error) {
    sendPayPalError(res, error)
  }
})

function toCaptureResult(order: PayPalOrder & Record<string, unknown>): CaptureResult {
  if (typeof order.id !== 'string' || !orderIdPattern.test(order.id) || typeof order.status !== 'string') {
    throw new Error('PayPal returned an invalid capture response')
  }

  const captures: CaptureResult['captures'] = []
  if (Array.isArray(order.purchase_units)) {
    for (const unit of order.purchase_units) {
      if (!isRecord(unit) || !isRecord(unit.payments) || !Array.isArray(unit.payments.captures)) {
        continue
      }
      for (const capture of unit.payments.captures) {
        if (
          !isRecord(capture) ||
          typeof capture.id !== 'string' ||
          typeof capture.status !== 'string'
        ) {
          continue
        }

        const result: CaptureResult['captures'][number] = {
          id: capture.id,
          status: capture.status,
        }
        if (
          isRecord(capture.amount) &&
          typeof capture.amount.currency_code === 'string' &&
          typeof capture.amount.value === 'string'
        ) {
          result.amount = {
            currencyCode: capture.amount.currency_code,
            value: capture.amount.value,
          }
        }
        captures.push(result)
      }
    }
  }

  return { id: order.id, status: order.status, captures }
}

async function captureOrder(orderId: string): Promise<CaptureResult> {
  const currentRequest = captureRequests.get(orderId)
  if (currentRequest) {
    return currentRequest
  }

  const request = paypalRequest<PayPalOrder & Record<string, unknown>>(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    'POST',
    {},
  ).then(toCaptureResult)

  captureRequests.set(orderId, request)
  try {
    const result = await request
    if (captureRequests.size > maxCachedCaptures) {
      const oldestOrderId = captureRequests.keys().next().value
      if (oldestOrderId) {
        captureRequests.delete(oldestOrderId)
      }
    }
    return result
  } catch (error) {
    captureRequests.delete(orderId)
    throw error
  }
}

router.post('/orders/:orderId/capture', async (req: Request, res: Response) => {
  const orderId: unknown = req.params.orderId
  if (typeof orderId !== 'string' || !orderIdPattern.test(orderId)) {
    res.status(400).json({ error: 'invalid_order_id' })
    return
  }

  try {
    res.json(await captureOrder(orderId))
  } catch (error) {
    sendPayPalError(res, error)
  }
})

function getCaptureOrderIds(): string[] {
  const configuredIds = process.env.PAYPAL_CAPTURE_ORDER_IDS
    ?.split(',')
    .map((orderId) => orderId.trim())
    .filter(Boolean)
  const orderIds = configuredIds?.length ? configuredIds : defaultCaptureOrderIds

  if (orderIds.some((orderId) => !orderIdPattern.test(orderId))) {
    throw new Error('Configured PayPal capture order IDs are invalid')
  }

  return [...new Set(orderIds)]
}

function extractCompletedCaptures(order: unknown): VerifiedSandboxCapture[] {
  if (
    !isRecord(order) ||
    typeof order.id !== 'string' ||
    !orderIdPattern.test(order.id) ||
    order.status !== 'COMPLETED' ||
    !Array.isArray(order.purchase_units)
  ) {
    return []
  }

  const captures: VerifiedSandboxCapture[] = []
  for (const unit of order.purchase_units) {
    if (!isRecord(unit) || !isRecord(unit.payments) || !Array.isArray(unit.payments.captures)) {
      continue
    }

    for (const capture of unit.payments.captures) {
      if (
        !isRecord(capture) ||
        typeof capture.id !== 'string' ||
        typeof capture.status !== 'string' ||
        capture.status !== 'COMPLETED' ||
        !isRecord(capture.amount) ||
        typeof capture.amount.value !== 'string' ||
        typeof capture.amount.currency_code !== 'string'
      ) {
        continue
      }

      captures.push({
        orderId: order.id,
        transactionId: capture.id,
        status: 'COMPLETED',
        amount: capture.amount.value,
        currency: capture.amount.currency_code,
      })
    }
  }

  return captures
}

router.get('/captures', async (_req: Request, res: Response) => {
  try {
    const orderIds = getCaptureOrderIds()
    const orders = await Promise.all(
      orderIds.map((orderId) =>
        paypalRequest<unknown>(
          `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
          'GET',
        ),
      ),
    )
    const transactions = orders.flatMap(extractCompletedCaptures)
    res.json({ source: 'paypal_sandbox', transactions })
  } catch (error) {
    sendPayPalError(res, error)
  }
})

export default router
