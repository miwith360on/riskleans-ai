import { Router, type Request, type Response } from 'express'
import { requireDemoAccess } from './auth'

const router = Router()
router.use(requireDemoAccess)
const orderIdPattern = /^[A-Z0-9]{1,64}$/i
const maxRegisteredOrders = 500
const defaultCaptureOrderIds = ['25H57639MT004512P']

type PayPalOrder = {
  id: string
  status: string
  links?: Array<{ rel?: string; href?: string }>
}
type RegisteredOrder = {
  state: 'pending_approval' | 'verifying' | 'capturing' | 'captured' | 'ineligible'
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
const registeredOrders = new Map<string, RegisteredOrder>()

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
  if (registeredOrders.size >= maxRegisteredOrders) {
    res.status(503).json({ error: 'order_registry_full' })
    return
  }

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
      order.status !== 'CREATED' ||
      !approvalUrl
    ) {
      throw new Error('PayPal returned an invalid order response')
    }

    if (registeredOrders.has(order.id)) {
      res.status(502).json({ error: 'paypal_order_registration_failed' })
      return
    }
    registeredOrders.set(order.id, { state: 'pending_approval' })
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

router.post('/orders/:orderId/capture', async (req: Request, res: Response) => {
  const orderId: unknown = req.params.orderId
  if (typeof orderId !== 'string' || !orderIdPattern.test(orderId)) {
    res.status(400).json({ error: 'invalid_order_id' })
    return
  }

  const registeredOrder = registeredOrders.get(orderId)
  if (!registeredOrder) {
    res.status(404).json({ error: 'unknown_order' })
    return
  }
  if (registeredOrder.state === 'captured') {
    res.status(409).json({ error: 'order_already_captured' })
    return
  }
  if (registeredOrder.state !== 'pending_approval') {
    res.status(409).json({
      error: registeredOrder.state === 'capturing' || registeredOrder.state === 'verifying'
        ? 'capture_in_progress'
        : 'order_not_eligible',
    })
    return
  }

  registeredOrder.state = 'verifying'
  try {
    const order = await paypalRequest<unknown>(
      `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
      'GET',
    )
    if (
      !isRecord(order) ||
      order.id !== orderId ||
      typeof order.status !== 'string'
    ) {
      registeredOrder.state = 'ineligible'
      res.status(502).json({ error: 'invalid_paypal_order_status' })
      return
    }
    if (order.status === 'COMPLETED') {
      registeredOrder.state = 'captured'
      res.status(409).json({ error: 'order_already_captured' })
      return
    }
    if (order.status !== 'APPROVED') {
      registeredOrder.state = 'ineligible'
      res.status(409).json({ error: 'order_not_eligible' })
      return
    }

    registeredOrder.state = 'capturing'
    try {
      const result = toCaptureResult(await paypalRequest<PayPalOrder & Record<string, unknown>>(
        `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
        'POST',
        {},
      ))
      if (
        result.status !== 'COMPLETED' ||
        !result.captures.some((capture) => capture.status === 'COMPLETED')
      ) {
        registeredOrder.state = 'ineligible'
        res.status(409).json({ error: 'capture_not_completed' })
        return
      }

      registeredOrder.state = 'captured'
      res.json(result)
    } catch (error) {
      registeredOrder.state = 'ineligible'
      throw error
    }
  } catch (error) {
    if (registeredOrder.state === 'verifying') {
      registeredOrder.state = 'pending_approval'
    }
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

// ---------------------------------------------------------------------------
// Verified capture lookup for AI investigation.
// The server reads the capture directly from PayPal so the AI only ever sees
// PayPal-returned facts, never values supplied by the browser.
// ---------------------------------------------------------------------------
export const captureIdPattern = /^[A-Z0-9]{8,64}$/i

export type VerifiedCaptureDetails = {
  captureId: string
  orderId?: string
  status: string
  amount: number
  currency: string
  createTime?: string
  finalCapture?: boolean
  sellerProtectionStatus?: string
  disputeCategories: string[]
  paypalFee?: string
  netAmount?: string
}

export class PayPalCaptureLookupError extends Error {
  constructor(readonly reason: 'not_found' | 'unavailable') {
    super(`PayPal capture lookup failed: ${reason}`)
  }
}

function moneyText(value: unknown): string | undefined {
  if (
    isRecord(value) &&
    typeof value.value === 'string' &&
    /^\d{1,9}(\.\d{1,2})?$/.test(value.value) &&
    typeof value.currency_code === 'string' &&
    /^[A-Z]{3}$/.test(value.currency_code)
  ) {
    return `${value.value} ${value.currency_code}`
  }
  return undefined
}

function safeLabel(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z0-9_]{1,40}$/.test(value) ? value : undefined
}

export async function fetchVerifiedCapture(captureId: string): Promise<VerifiedCaptureDetails> {
  if (!captureIdPattern.test(captureId)) {
    throw new PayPalCaptureLookupError('not_found')
  }

  let capture: unknown
  try {
    capture = await paypalRequest<unknown>(`/v2/payments/captures/${encodeURIComponent(captureId)}`, 'GET')
  } catch (error) {
    if (error instanceof PayPalApiError && error.statusCode === 404) {
      throw new PayPalCaptureLookupError('not_found')
    }
    throw new PayPalCaptureLookupError('unavailable')
  }

  if (
    !isRecord(capture) ||
    capture.id !== captureId ||
    typeof capture.status !== 'string' ||
    !isRecord(capture.amount) ||
    typeof capture.amount.value !== 'string' ||
    typeof capture.amount.currency_code !== 'string' ||
    !/^[A-Z]{3}$/.test(capture.amount.currency_code)
  ) {
    throw new PayPalCaptureLookupError('unavailable')
  }

  const amount = Number(capture.amount.value)
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new PayPalCaptureLookupError('unavailable')
  }

  const details: VerifiedCaptureDetails = {
    captureId,
    status: safeLabel(capture.status) ?? 'UNKNOWN',
    amount,
    currency: capture.amount.currency_code,
    disputeCategories: [],
  }

  if (typeof capture.create_time === 'string' && !Number.isNaN(Date.parse(capture.create_time))) {
    details.createTime = new Date(capture.create_time).toISOString()
  }
  if (typeof capture.final_capture === 'boolean') {
    details.finalCapture = capture.final_capture
  }
  if (isRecord(capture.seller_protection)) {
    details.sellerProtectionStatus = safeLabel(capture.seller_protection.status)
    if (Array.isArray(capture.seller_protection.dispute_categories)) {
      details.disputeCategories = capture.seller_protection.dispute_categories
        .map(safeLabel)
        .filter((item): item is string => Boolean(item))
        .slice(0, 5)
    }
  }
  if (isRecord(capture.seller_receivable_breakdown)) {
    details.paypalFee = moneyText(capture.seller_receivable_breakdown.paypal_fee)
    details.netAmount = moneyText(capture.seller_receivable_breakdown.net_amount)
  }
  if (
    isRecord(capture.supplementary_data) &&
    isRecord(capture.supplementary_data.related_ids) &&
    typeof capture.supplementary_data.related_ids.order_id === 'string' &&
    orderIdPattern.test(capture.supplementary_data.related_ids.order_id)
  ) {
    details.orderId = capture.supplementary_data.related_ids.order_id
  }

  return details
}

// Same transparent rules the dashboard uses. Only the amount rule can be
// applied to a capture: PayPal does not return history, frequency or tenure.
export function scoreVerifiedCapture(capture: VerifiedCaptureDetails): { riskScore: number; riskLevel: 'High' | 'Medium' | 'Low' } {
  const amountPoints = capture.amount > 1000 ? 38 : capture.amount > 500 ? 22 : 0
  const riskScore = Math.min(100, 5 + amountPoints)
  const riskLevel = riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low'
  return { riskScore, riskLevel }
}
