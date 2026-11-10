import assert from 'node:assert/strict'
import { once } from 'node:events'
import { test, type TestContext } from 'node:test'
import express from 'express'
import aiRouter from './ai'

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
): Promise<Response> {
  const previousFetch = globalThis.fetch
  const previousApiKey = process.env.OPENAI_API_KEY
  const previousModel = process.env.OPENAI_MODEL
  delete process.env.OPENAI_MODEL
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
  })

  const app = express()
  app.use(express.json({ limit: '10kb' }))
  app.use('/api/ai', aiRouter)
  const server = app.listen(0)
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve())
  }))

  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    return await previousFetch(`http://127.0.0.1:${address.port}/api/ai/investigate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
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
