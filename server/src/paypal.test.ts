import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import express from 'express'
import paypalRouter from './paypal'

type PayPalLink = { rel: string; href: string }

async function createOrderWithLinks(
  t: TestContext,
  links: PayPalLink[],
): Promise<unknown> {
  const previousFetch = globalThis.fetch
  const previousEnvironment = {
    PAYPAL_BASE_URL: process.env.PAYPAL_BASE_URL,
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
    PAYPAL_RETURN_URL: process.env.PAYPAL_RETURN_URL,
    PAYPAL_CANCEL_URL: process.env.PAYPAL_CANCEL_URL,
  }
  process.env.PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com'
  process.env.PAYPAL_CLIENT_ID = 'mock-client-id'
  process.env.PAYPAL_CLIENT_SECRET = 'mock-client-secret'
  process.env.PAYPAL_RETURN_URL = 'http://localhost:5173/?paypal=return'
  process.env.PAYPAL_CANCEL_URL = 'http://localhost:5173/?paypal=cancel'

  globalThis.fetch = async (input, init) => {
    const url = new URL(input.toString())
    assert.equal(url.hostname, 'api-m.sandbox.paypal.com')

    if (url.pathname === '/v1/oauth2/token') {
      assert.equal(init?.method, 'POST')
      return Response.json({ access_token: 'mock-access-token', expires_in: 3600 })
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
        id: 'MOCKORDER123',
        status: 'CREATED',
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
  const response = await previousFetch(
    `http://127.0.0.1:${address.port}/api/paypal/orders`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  )
  assert.equal(response.status, 201)
  return response.json()
}

test('prefers the payer-action URL when PayPal returns both approval relations', async (t) => {
  const payerActionUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER123&useraction=commit'
  const body = await createOrderWithLinks(t, [
    { rel: 'approve', href: 'https://www.sandbox.paypal.com/legacy-approval?token=MOCKORDER123' },
    { rel: 'payer-action', href: payerActionUrl },
  ])

  assert.deepEqual(body, {
    id: 'MOCKORDER123',
    status: 'CREATED',
    approvalUrl: payerActionUrl,
  })
})

test('falls back to the approve URL when payer-action is absent', async (t) => {
  const approveUrl = 'https://www.sandbox.paypal.com/checkoutnow?token=MOCKORDER123'
  const body = await createOrderWithLinks(t, [
    { rel: 'approve', href: approveUrl },
  ])

  assert.deepEqual(body, {
    id: 'MOCKORDER123',
    status: 'CREATED',
    approvalUrl: approveUrl,
  })
})

test('returns only PayPal-verified completed captures without payer details', async (t) => {
  const previousFetch = globalThis.fetch
  const previousEnvironment = {
    PAYPAL_BASE_URL: process.env.PAYPAL_BASE_URL,
    PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET,
    PAYPAL_CAPTURE_ORDER_IDS: process.env.PAYPAL_CAPTURE_ORDER_IDS,
  }
  const orderId = '25H57639MT004512P'
  process.env.PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com'
  process.env.PAYPAL_CLIENT_ID = 'mock-client-id'
  process.env.PAYPAL_CLIENT_SECRET = 'mock-client-secret'
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
  const response = await previousFetch(
    `http://127.0.0.1:${address.port}/api/paypal/captures`,
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
