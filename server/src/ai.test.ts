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
  return previousFetch(`http://127.0.0.1:${address.port}/api/ai/investigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
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
})

test('maps provider rate limits to a retryable service-unavailable response', async (t) => {
  process.env.OPENAI_API_KEY = 'test-key'
  const response = await postInvestigation(t, requestBody, async () => new Response(null, { status: 429 }))

  assert.equal(response.status, 503)
  assert.deepEqual(await response.json(), { error: 'ai_rate_limited' })
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
  assert.deepEqual(await response.json(), { error: 'ai_invalid_response' })
})
