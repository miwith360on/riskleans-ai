import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import express from 'express'
import { createAiRouter, InMemoryAiRequestLimiter } from './ai'
import { assertDemoAccessTokenConfigured } from './auth'

const demoAccessToken = 'test-demo-access-token-with-at-least-32-chars'

const requestBody = {
  transactionId: 'TXN-1042',
  evidence: {
    amount: 1850,
    ageMinutes: 2,
    paymentsIn10Minutes: 5,
    newCustomer: true,
    outsideHours: true,
    riskScore: 100,
    riskLevel: 'High',
  },
}

async function postInvestigation(
  t: TestContext,
  body: unknown,
  providerFetch?: typeof fetch,
  options: {
    authorization?: string | null
    limiter?: InMemoryAiRequestLimiter
  } = {},
): Promise<Response> {
  const previousFetch = globalThis.fetch
  const previousApiKey = process.env.OPENAI_API_KEY
  const previousModel = process.env.OPENAI_MODEL
  const previousAccessToken = process.env.DEMO_ACCESS_TOKEN
  delete process.env.OPENAI_MODEL
  process.env.DEMO_ACCESS_TOKEN = demoAccessToken
  globalThis.fetch = providerFetch ?? (async () => {
    throw new Error('Unexpected model API request')
  })

  t.after(() => {
    globalThis.fetch = previousFetch
    if (previousApiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousApiKey
    }
    if (previousModel === undefined) {
      delete process.env.OPENAI_MODEL
    } else {
      process.env.OPENAI_MODEL = previousModel
    }
    if (previousAccessToken === undefined) {
      delete process.env.DEMO_ACCESS_TOKEN
    } else {
      process.env.DEMO_ACCESS_TOKEN = previousAccessToken
    }
  })

  const app = express()
  app.use(express.json({ limit: '10kb' }))
  app.use(
    '/api/ai',
    createAiRouter(options.limiter ?? new InMemoryAiRequestLimiter({
      requestsPerMinute: 100,
      maxRequests: 1_000,
    })),
  )
  const server = app.listen(0)
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))

  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (options.authorization !== null) {
    headers.set('Authorization', options.authorization ?? `Bearer ${demoAccessToken}`)
  }
  try {
    return await previousFetch(`http://127.0.0.1:${address.port}/api/ai/investigate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
  } finally {
    globalThis.fetch = previousFetch
  }
}

test('rejects invalid transaction identifiers and evidence before contacting the model', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  let providerCalls = 0
  const response = await postInvestigation(t, {
    ...requestBody,
    transactionId: 'paypal/capture',
  }, async () => {
    providerCalls += 1
    return Response.json({})
  })

  test('rejects missing and incorrect demo access tokens before contacting the model', async (t) => {
    process.env.OPENAI_API_KEY = 'test-key'
    let providerCalls = 0
    const providerFetch = async () => {
      providerCalls += 1
      return Response.json({})
    }
    const missing = await postInvestigation(t, requestBody, providerFetch, { authorization: null })
    assert.equal(missing.status, 401)
    assert.deepEqual(await missing.json(), { error: 'demo_access_token_required' })

    const invalid = await postInvestigation(t, requestBody, providerFetch, {
      authorization: 'Bearer wrong-token',
    })

    test('requires a strong demo token in production configuration', (t) => {
      const previousNodeEnv = process.env.NODE_ENV
      const previousAccessToken = process.env.DEMO_ACCESS_TOKEN
      t.after(() => {
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousNodeEnv
        if (previousAccessToken === undefined) delete process.env.DEMO_ACCESS_TOKEN
        else process.env.DEMO_ACCESS_TOKEN = previousAccessToken
      })

      process.env.NODE_ENV = 'production'
      delete process.env.DEMO_ACCESS_TOKEN
      assert.throws(() => assertDemoAccessTokenConfigured(), /DEMO_ACCESS_TOKEN/)
      process.env.DEMO_ACCESS_TOKEN = demoAccessToken
      assert.doesNotThrow(() => assertDemoAccessTokenConfigured())
    })
    assert.equal(invalid.status, 401)
    assert.deepEqual(await invalid.json(), { error: 'invalid_demo_access_token' })
    assert.equal(providerCalls, 0)
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_investigation_request' })
  assert.equal(providerCalls, 0)
})

test('rejects out-of-range evidence before contacting the model', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  let providerCalls = 0
  const response = await postInvestigation(t, {
    ...requestBody,
    evidence: { ...requestBody.evidence, amount: 0 },
  }, async () => {
    providerCalls += 1
    return Response.json({})
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), { error: 'invalid_investigation_request' })
  assert.equal(providerCalls, 0)
})

test('reports unavailable credentials without calling the model', async (t) => {
  delete process.env.OPENAI_API_KEY
  let providerCalls = 0
  const response = await postInvestigation(t, requestBody, async () => {
    providerCalls += 1
    return Response.json({})
  })

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'ai_not_configured' })
  assert.equal(providerCalls, 0)
})

test('returns a grounded model response without sending identifiers or names to the provider', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  let requestJson = ''
  const response = await postInvestigation(t, requestBody, async (_input, init) => {
    requestJson = String(init?.body)
    const citedEvidence = 'Amount: 1850.00 USD (synthetic demo data).'
    return Response.json({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            summary: 'The synthetic payment has several configured signals for human review.',
            observations: [{
              observation: 'The amount is above the other evidence values in this record.',
              evidence: citedEvidence,
            }],
            uncertainty: ['No real customer history or device information is provided.'],
            recommendedActions: ['Review the synthetic rule signals and compare them with trusted records.'],
          }),
        },
      }],
    })
  })

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    transactionId: 'TXN-1042',
    source: 'synthetic_demo',
    riskScore: 100,
    riskLevel: 'High',
    investigation: {
      summary: 'The synthetic payment has several configured signals for human review.',
      observations: [{
        observation: 'The amount is above the other evidence values in this record.',
        evidence: 'Amount: 1850.00 USD (synthetic demo data).',
      }],
      uncertainty: ['No real customer history or device information is provided.'],
      recommendedActions: ['Review the synthetic rule signals and compare them with trusted records.'],
    },
  })
  assert.equal(requestJson.includes('TXN-1042'), false)
  assert.equal(requestJson.includes('Avery Morgan'), false)
  assert.equal(requestJson.includes('1850.00'), true)
  const providerRequest = JSON.parse(requestJson) as {
    model: string
    temperature?: number
    max_completion_tokens: number
    reasoning_effort: string
    response_format: {
      type: string
    json_schema: {
      strict: boolean
      schema: {
        required: string[]
        properties: {
          observations: {
            items: { properties: { evidence: { enum: string[] } } }
          }
        }
      }
    }
    }
  }
  assert.equal(providerRequest.model, 'gpt-5.4-mini')
  assert.equal(providerRequest.temperature, undefined)
  assert.equal(providerRequest.max_completion_tokens, 1_200)
  assert.equal(providerRequest.reasoning_effort, 'low')
  assert.equal(providerRequest.response_format.type, 'json_schema')
  assert.equal(providerRequest.response_format.json_schema.strict, true)
  assert.deepEqual(providerRequest.response_format.json_schema.schema.required, [
    'summary',
    'observations',
    'uncertainty',
    'recommendedActions',
  ])
  assert.equal(
    providerRequest.response_format.json_schema.schema.properties.observations.items.properties.evidence.enum.includes(
      'Amount: 1850.00 USD (synthetic demo data).',
    ),
    true,
  )
})

test('maps provider rate limits to a retryable service-unavailable response', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const response = await postInvestigation(t, requestBody, async () => new Response(null, { status: 429 }))

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: 'ai_rate_limited',
    upstreamStatus: 429,
  })

  test('rate limits requests before invoking the provider', async (t) => {
    process.env.OPENAI_API_KEY = 'test-key'
    const limiter = new InMemoryAiRequestLimiter({ requestsPerMinute: 1, maxRequests: 10 })
    let providerCalls = 0
    const providerFetch = async () => {
      providerCalls += 1
      return Response.json({
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            summary: 'Synthetic transaction reviewed.',
            observations: [],
            uncertainty: ['Synthetic evidence only.'],
            recommendedActions: ['Human review only.'],
          }) },
        }],
      })
    }
    const first = await postInvestigation(t, requestBody, providerFetch, { limiter })
    assert.equal(first.status, 200)
    const second = await postInvestigation(t, requestBody, providerFetch, { limiter })
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), '60')
    assert.deepEqual(await second.json(), { error: 'ai_rate_limited' })
    assert.equal(providerCalls, 1)
  })

  test('enforces the process-wide AI request cap before provider invocation', async (t) => {
    process.env.OPENAI_API_KEY = 'test-key'
    const limiter = new InMemoryAiRequestLimiter({ requestsPerMinute: 10, maxRequests: 1 })
    let providerCalls = 0
    const providerFetch = async () => {
      providerCalls += 1
      return Response.json({
        choices: [{
          finish_reason: 'stop',
          message: { content: JSON.stringify({
            summary: 'Synthetic transaction reviewed.',
            observations: [],
            uncertainty: ['Synthetic evidence only.'],
            recommendedActions: ['Human review only.'],
          }) },
        }],
      })

      test('atomically limits simultaneous AI request reservations', async () => {
        const limiter = new InMemoryAiRequestLimiter({ requestsPerMinute: 1, maxRequests: 10 })
        const results = await Promise.all(
          Array.from({ length: 10 }, () => Promise.resolve().then(() => limiter.acquire())),
        )
        assert.equal(results.filter((result) => result === 'allowed').length, 1)
        assert.equal(results.filter((result) => result === 'rate_limited').length, 9)
      })
    }
    const first = await postInvestigation(t, requestBody, providerFetch, { limiter })
    assert.equal(first.status, 200)
    const second = await postInvestigation(t, requestBody, providerFetch, { limiter })
    assert.equal(second.status, 429)
    assert.deepEqual(await second.json(), { error: 'ai_usage_limit_reached' })
    assert.equal(providerCalls, 1)
  })
})

test('distinguishes insufficient quota from rate limiting', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const response = await postInvestigation(t, requestBody, async () => Response.json({
    error: { code: 'insufficient_quota', type: 'insufficient_quota' },
  }, { status: 429 }))

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: 'ai_insufficient_quota',
    upstreamStatus: 429,
    providerCode: 'insufficient_quota',
  })
})

test('distinguishes invalid credentials and inaccessible models', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const authentication = await postInvestigation(t, requestBody, async () => Response.json({
    error: { code: 'invalid_api_key', type: 'authentication_error' },
  }, { status: 401, headers: { 'x-request-id': 'req_safe-123' } }))
  assert.equal(authentication.status, 503)
  assert.deepEqual(await authentication.json(), {
    error: 'ai_authentication_failed',
    upstreamStatus: 401,
    providerCode: 'invalid_api_key',
    requestId: 'req_safe-123',
  })

  const inaccessibleModel = await postInvestigation(t, requestBody, async () => Response.json({
    error: { code: 'model_not_found', type: 'invalid_request_error' },
  }, { status: 404 }))
  assert.equal(inaccessibleModel.status, 503)
  assert.deepEqual(await inaccessibleModel.json(), {
    error: 'ai_model_not_found',
    upstreamStatus: 404,
    providerCode: 'model_not_found',
  })

  const forbiddenModel = await postInvestigation(t, requestBody, async () => Response.json({
    error: { code: 'model_access_denied', type: 'permission_error' },
  }, { status: 403 }))
  assert.equal(forbiddenModel.status, 503)
  assert.deepEqual(await forbiddenModel.json(), {
    error: 'ai_model_access_denied',
    upstreamStatus: 403,
    providerCode: 'model_access_denied',
  })
})

test('identifies invalid requests and provider outages separately', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const invalidRequest = await postInvestigation(t, requestBody, async () => Response.json({
    error: { code: 'unsupported_value', type: 'invalid_request_error', message: 'private details excluded' },
  }, { status: 400 }))
  assert.equal(invalidRequest.status, 502)
  assert.deepEqual(await invalidRequest.json(), {
    error: 'ai_invalid_request',
    upstreamStatus: 400,
    providerCode: 'unsupported_value',
  })

  const outage = await postInvestigation(t, requestBody, async () => Response.json({
    error: { code: 'server_error', type: 'server_error' },
  }, { status: 503 }))
  assert.equal(outage.status, 502)
  assert.deepEqual(await outage.json(), {
    error: 'ai_provider_outage',
    upstreamStatus: 503,
    providerCode: 'server_error',
  })
})

test('returns a timeout response when the model request times out', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const response = await postInvestigation(t, requestBody, async () => {
    const error = new Error('timed out')
    error.name = 'TimeoutError'
    throw error
  })

  assert.equal(response.status, 504)
  assert.deepEqual(await response.json(), { error: 'ai_request_timeout' })
})

test('rejects model observations that do not cite supplied evidence', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const response = await postInvestigation(t, requestBody, async () => Response.json({
    choices: [{
      finish_reason: 'stop',
      message: {
        content: JSON.stringify({
          summary: 'Unsupported response.',
          observations: [{ observation: 'It is suspicious.', evidence: 'The customer has a history of fraud.' }],
          uncertainty: [],
          recommendedActions: [],
        }),
      },
    }],
  }))

  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'ai_evidence_mismatch' })
})

test('rejects provider refusal output instead of treating it as an investigation', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const response = await postInvestigation(t, requestBody, async () => Response.json({
    choices: [{
      finish_reason: 'stop',
      message: { refusal: 'I cannot complete this request.', content: null },
    }],
  }))

  assert.equal(response.status, 502)
  assert.deepEqual(await response.json(), { error: 'ai_response_refused' })
})

test('reports truncated output distinctly from malformed structured content', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const truncated = await postInvestigation(t, requestBody, async () => Response.json({
    choices: [{
      finish_reason: 'length',
      message: { content: null },
    }],
  }))
  assert.equal(truncated.status, 502)
  assert.deepEqual(await truncated.json(), { error: 'ai_response_incomplete' })

  const malformed = await postInvestigation(t, requestBody, async () => Response.json({
    choices: [{
      finish_reason: 'stop',
      message: { content: '{invalid' },
    }],
  }))
  assert.equal(malformed.status, 502)
  assert.deepEqual(await malformed.json(), { error: 'ai_response_invalid_json' })
})

test('investigates a PayPal Sandbox capture using only facts fetched from PayPal', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const previousPayPal = {
    base: process.env.PAYPAL_BASE_URL,
    id: process.env.PAYPAL_CLIENT_ID,
    secret: process.env.PAYPAL_CLIENT_SECRET,
  }
  process.env.PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com'
  process.env.PAYPAL_CLIENT_ID = 'test-client'
  process.env.PAYPAL_CLIENT_SECRET = 'test-secret'
  t.after(() => {
    for (const [key, value] of [
      ['PAYPAL_BASE_URL', previousPayPal.base],
      ['PAYPAL_CLIENT_ID', previousPayPal.id],
      ['PAYPAL_CLIENT_SECRET', previousPayPal.secret],
    ] as const) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  let modelRequest = ''
  const response = await postInvestigation(t, {
    source: 'paypal_sandbox',
    transactionId: '4CK42679OL825515W',
    // Browser-supplied evidence must be ignored for PayPal captures.
    evidence: { amount: 999999, riskScore: 100, riskLevel: 'High' },
  }, async (input, init) => {
    const url = String(input)
    if (url.endsWith('/v1/oauth2/token')) {
      return Response.json({ access_token: 'sandbox-token', expires_in: 3600 })
    }
    if (url.endsWith('/v2/payments/captures/4CK42679OL825515W')) {
      return Response.json({
        id: '4CK42679OL825515W',
        status: 'COMPLETED',
        amount: { currency_code: 'USD', value: '10.00' },
        final_capture: true,
        create_time: '2026-11-09T23:58:00Z',
        seller_protection: { status: 'ELIGIBLE', dispute_categories: ['ITEM_NOT_RECEIVED', 'UNAUTHORIZED_TRANSACTION'] },
        seller_receivable_breakdown: {
          gross_amount: { currency_code: 'USD', value: '10.00' },
          paypal_fee: { currency_code: 'USD', value: '0.84' },
          net_amount: { currency_code: 'USD', value: '9.16' },
        },
        supplementary_data: { related_ids: { order_id: '25H57639MT004512P' } },
      })
    }
    modelRequest = String(init?.body)
    return Response.json({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            summary: 'A small completed Sandbox payment with seller protection.',
            observations: [{
              observation: 'PayPal reports this payment as eligible for seller protection.',
              evidence: 'PayPal seller protection: ELIGIBLE (covers: ITEM_NOT_RECEIVED, UNAUTHORIZED_TRANSACTION).',
            }],
            uncertainty: ['No customer history is available from capture data.'],
            recommendedActions: ['Confirm the order was fulfilled before marking it reviewed.'],
          }),
        },
      }],
    })
  })

  assert.equal(response.status, 200)
  const body = await response.json() as { source: string; transactionId: string; riskScore: number; riskLevel: string }
  assert.equal(body.source, 'paypal_sandbox')
  assert.equal(body.transactionId, '4CK42679OL825515W')
  assert.equal(body.riskScore, 5)
  assert.equal(body.riskLevel, 'Low')
  assert.equal(modelRequest.includes('4CK42679OL825515W'), false)
  assert.equal(modelRequest.includes('25H57639MT004512P'), false)
  assert.equal(modelRequest.includes('999999'), false)
  assert.equal(modelRequest.includes('10.00 USD (PayPal Sandbox capture)'), true)
})

test('rejects PayPal capture IDs with unsafe characters before contacting PayPal or the model', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  let calls = 0
  const response = await postInvestigation(t, { source: 'paypal_sandbox', transactionId: '../orders/X' }, async () => {
    calls += 1
    return Response.json({})
  })
  assert.equal(response.status, 400)
  assert.equal(calls, 0)
})
