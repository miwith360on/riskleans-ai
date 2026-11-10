import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import express from 'express'
import paypalRouter from './paypal'

type PayPalLink = { rel: string; href: string }
const demoAccessToken = 'test-demo-access-token-with-at-least-32-chars'
let nextMockOrderId = 0
const nativeFetch = globalThis.fetch

async function createOrderWithLinks(
  t: TestContext,
  links: PayPalLink[],
  options: {
    authorized?: boolean
    orderStatus?: string
    registeredOrderStatus?: string
    captureGate?: { started: () => void; wait: Promise<void> }
  } = {},
): Promise<{ body: unknown; baseUrl: string; orderId: string; captureCount: () => number }> {
  const previousFetch = globalThis.fetch
  const previousEnvironment = {
    PAYPAL_BASE_URL: process.env.PAYPAL_BASE_URL,
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
    PAYPAL_RETURN_URL: process.env.PAYPAL_RETURN_URL,
    PAYPAL_CANCEL_URL: process.env.PAYPAL_CANCEL_URL,
    DEMO_ACCESS_TOKEN: process.env.DEMO_ACCESS_TOKEN,
  }
  const orderId = `MOCKORDER${++nextMockOrderId}`
  let captureCount = 0
  let paypalRequestCount = 0
  process.env.PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com'
  process.env.PAYPAL_CLIENT_ID = 'mock-client-id'
  process.env.PAYPAL_CLIENT_SECRET = 'mock-client-secret'
  process.env.PAYPAL_RETURN_URL = 'http://localhost:5173/?paypal=return'
  process.env.PAYPAL_CANCEL_URL = 'http://localhost:5173/?paypal=cancel'
  process.env.DEMO_ACCESS_TOKEN = demoAccessToken

  globalThis.fetch = async (input, init) => {
    const url = new URL(input.toString())
    assert.equal(url.hostname, 'api-m.sandbox.paypal.com')

    if (url.pathname === '/v1/oauth2/token') {
      paypalRequestCount += 1
      assert.equal(init?.method, 'POST')
      return Response.json({ access_token: 'mock-access-token', expires_in: 3600 })
    }
    paypalRequestCount += 1

    if (url.pathname === `/v2/checkout/orders/${orderId}` && init?.method === 'GET') {
      return Response.json({ id: orderId, status: options.registeredOrderStatus ?? 'APPROVED' })
    }
    if (url.pathname === `/v2/checkout/orders/${orderId}/capture` && init?.method === 'POST') {
      captureCount += 1
      options.captureGate?.started()
      if (options.captureGate) {
        await options.captureGate.wait
      }
      return Response.json({
        id: orderId,
        status: 'COMPLETED',
        purchase_units: [{
          payments: {
            captures: [{
              id: 'MOCKCAPTURE123',
              status: 'COMPLETED',
              amount: { value: '10.00', currency_code: 'USD' },
            }],
          },
        }],
      })
    }

    assert.equal(url.pathname, '/v2/checkout/orders')
    assert.equal(init?.method, 'POST')
    const order = JSON.parse(String(init?.body)) as {
      purchase_units: Array<{ amount: { currency_code: string; value: string } }>
      application_context: {
        return_url: string
        cancel_url: string
        user_action: string
      }
    }
    assert.equal(order.purchase_units[0]?.amount.currency_code, 'USD')
    assert.equal(order.purchase_units[0]?.amount.value, '10.00')
    const returnUrl = new URL(order.application_context.return_url)
    const cancelUrl = new URL(order.application_context.cancel_url)
    assert.equal(returnUrl.origin, 'http://localhost:5173')
    assert.equal(returnUrl.searchParams.get('paypal'), 'return')
    assert.equal(cancelUrl.origin, 'http://localhost:5173')
    assert.equal(cancelUrl.searchParams.get('paypal'), 'cancel')
    assert.equal(order.application_context.user_action, 'PAY_NOW')

    return Response.json(
      {
        id: orderId,
        status: options.orderStatus ?? 'CREATED',
        links,
      },
      { status: 201 },
    )
  }

  t.after(async () => {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    if (previousEnvironment.DEMO_ACCESS_TOKEN === undefined) {
      delete process.env.DEMO_ACCESS_TOKEN
    } else {
      process.env.DEMO_ACCESS_TOKEN = previousEnvironment.DEMO_ACCESS_TOKEN
    }
  })

  const app = express()
  app.use(express.json())
  app.use('/api/paypal', paypalRouter)
  const server = app.listen(0)
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))

  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (options.authorized !== false) {
    headers.set('Authorization', `Bearer ${demoAccessToken}`)
  }
  const response = await nativeFetch(
    `http://127.0.0.1:${address.port}/api/paypal/orders`,
    { method: 'POST', headers, body: '{}' },
  )
  assert.equal(response.status, options.authorized === false ? 401 : 201)
  return {
    body: await response.json(),
    baseUrl: `http://127.0.0.1:${address.port}`,
    orderId,
    captureCount: () => captureCount,
    paypalRequestCount: () => paypalRequestCount,
  }
}

test('prefers the payer-action URL when PayPal returns both approval relations', async (t) => {
  const payerActionUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER123&useraction=commit'
  const result = await createOrderWithLinks(t, [
    { rel: 'approve', href: 'https://www.sandbox.paypal.com/legacy-approval?token=MOCKORDER123' },
    { rel: 'payer-action', href: payerActionUrl },
  ])

  assert.deepEqual(result.body, {
    id: result.orderId,
    status: 'CREATED',
    approvalUrl: payerActionUrl,
  })
})

test('falls back to the approve URL when payer-action is absent', async (t) => {
  const approveUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER123'
  const result = await createOrderWithLinks(t, [
    { rel: 'approve', href: approveUrl },
  ])

  assert.deepEqual(result.body, {
    id: result.orderId,
    status: 'CREATED',
    approvalUrl: approveUrl,
  })
})

  test('rejects unauthorized order creation before calling PayPal', async (t) => {
    const result = await createOrderWithLinks(t, [], { authorized: false })
    assert.deepEqual(result.body, { error: 'demo_access_token_required' })
    assert.equal(result.paypalRequestCount(), 0)
  })

  test('rejects unknown and unapproved captures without capture calls', async (t) => {
    const fixture = await createOrderWithLinks(t, [
      { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER' },
    ], { registeredOrderStatus: 'CREATED' })

    const tokenHeaders = { Authorization: `Bearer ${demoAccessToken}` }
    const unknownResponse = await nativeFetch(
      `${fixture.baseUrl}/api/paypal/orders/UNKNOWN123/capture`,
      { method: 'POST', headers: tokenHeaders },
    )
    assert.equal(unknownResponse.status, 404)
    assert.deepEqual(await unknownResponse.json(), { error: 'unknown_order' })

    const ineligibleResponse = await nativeFetch(
      `${fixture.baseUrl}/api/paypal/orders/${fixture.orderId}/capture`,
      { method: 'POST', headers: tokenHeaders },
    )
    assert.equal(ineligibleResponse.status, 409)
    assert.deepEqual(await ineligibleResponse.json(), { error: 'order_not_eligible' })
    assert.equal(fixture.captureCount(), 0)
  })

  test('captures only registered approved orders and rejects duplicate captures', async (t) => {
    const fixture = await createOrderWithLinks(t, [
      { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER' },
    ])
    const url = `${fixture.baseUrl}/api/paypal/orders/${fixture.orderId}/capture`
    const init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${demoAccessToken}` },
    }
    const first = await nativeFetch(url, init)
    assert.equal(first.status, 200)
    assert.equal((await first.json() as { status: string }).status, 'COMPLETED')
    assert.equal(fixture.captureCount(), 1)

    const duplicate = await nativeFetch(url, init)
    assert.equal(duplicate.status, 409)
    assert.deepEqual(await duplicate.json(), { error: 'order_already_captured' })
    assert.equal(fixture.captureCount(), 1)
  })

  test('rejects concurrent duplicate capture attempts while a capture is in progress', async (t) => {
    let markStarted!: () => void
    let releaseCapture!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const wait = new Promise<void>((resolve) => { releaseCapture = resolve })
    const fixture = await createOrderWithLinks(t, [
      { rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER' },
    ], {
      captureGate: { started: markStarted, wait },
    })
    const url = `${fixture.baseUrl}/api/paypal/orders/${fixture.orderId}/capture`
    const init = {
      method: 'POST',
      headers: { Authorization: `Bearer ${demoAccessToken}` },
    }

    const firstCapture = nativeFetch(url, init)
    await started
    const duplicate = await nativeFetch(url, init)
    assert.equal(duplicate.status, 409)
    assert.deepEqual(await duplicate.json(), { error: 'capture_in_progress' })
    assert.equal(fixture.captureCount(), 1)
    releaseCapture()
    assert.equal((await firstCapture).status, 200)
    assert.equal(fixture.captureCount(), 1)
  })

test('returns only PayPal-verified completed captures without payer details', async (t) => {
  const previousFetch = globalThis.fetch
  const previousEnvironment = {
    PAYPAL_BASE_URL: process.env.PAYPAL_BASE_URL,
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
    PAYPAL_CAPTURE_ORDER_IDS: process.env.PAYPAL_CAPTURE_ORDER_IDS,
    DEMO_ACCESS_TOKEN: process.env.DEMO_ACCESS_TOKEN,
  }
  const orderId = '25H57639MT004512P'
  process.env.PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com'
  process.env.PAYPAL_CLIENT_ID = 'mock-client-id'
  process.env.PAYPAL_CLIENT_SECRET = 'mock-client-secret'
  process.env.DEMO_ACCESS_TOKEN = demoAccessToken
  delete process.env.PAYPAL_CAPTURE_ORDER_IDS

  globalThis.fetch = async (input, init) => {
    const url = new URL(input.toString())
    assert.equal(url.hostname, 'api-m.sandbox.paypal.com')

    if (url.pathname === '/v1/oauth2/token') {
      return Response.json({ access_token: 'mock-access-token', expires_in: 3600 })
    }

    assert.equal(url.pathname, `/v2/checkout/orders/${orderId}`)
    assert.equal(init?.method, 'GET')
    assert.ok(new Headers(init?.headers).get('Authorization'))

    return Response.json({
      id: orderId,
      status: 'COMPLETED',
      payer: { name: { given_name: 'Must not be returned' } },
      purchase_units: [{
        payments: {
          captures: [
            {
              id: 'MOCKCAPTURE123',
              status: 'COMPLETED',
              amount: { value: '10.00', currency_code: 'USD' },
            },
            {
              id: 'MOCKPENDING456',
              status: 'PENDING',
              amount: { value: '3.00', currency_code: 'USD' },
            },
          ],
        },
      }],
    })
  }

  t.after(() => {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
    if (previousEnvironment.DEMO_ACCESS_TOKEN === undefined) {
      delete process.env.DEMO_ACCESS_TOKEN
    } else {
      process.env.DEMO_ACCESS_TOKEN = previousEnvironment.DEMO_ACCESS_TOKEN
    }
  })

  const app = express()
  app.use('/api/paypal', paypalRouter)
  const server = app.listen(0)
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))

  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const response = await nativeFetch(
    `http://127.0.0.1:${address.port}/api/paypal/captures`,
    { headers: { Authorization: `Bearer ${demoAccessToken}` } },
  )

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    source: 'paypal_sandbox',
    transactions: [{
      orderId,
      transactionId: 'MOCKCAPTURE123',
      status: 'COMPLETED',
      amount: '10.00',
      currency: 'USD',
    }],
  })
})
