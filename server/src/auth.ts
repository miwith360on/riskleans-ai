import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

const minimumTokenLength = 32

function getConfiguredToken(): string | undefined {
  const token = process.env.DEMO_ACCESS_TOKEN?.trim()
  return token && token.length >= minimumTokenLength ? token : undefined
}

export function assertDemoAccessTokenConfigured(): void {
  if (process.env.NODE_ENV === 'production' && !getConfiguredToken()) {
    throw new Error('DEMO_ACCESS_TOKEN must be configured with at least 32 characters in production')
  }
}

export function requireDemoAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const configuredToken = getConfiguredToken()
  if (!configuredToken) {
    res.status(503).json({ error: 'access_control_not_configured' })
    return
  }

  const authorization = req.get('authorization')
  const suppliedToken = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1]
  if (!suppliedToken) {
    res.status(401).json({ error: 'demo_access_token_required' })
    return
  }

  const configuredHash = createHash('sha256').update(configuredToken).digest()
  const suppliedHash = createHash('sha256').update(suppliedToken).digest()
  if (!timingSafeEqual(configuredHash, suppliedHash)) {
    res.status(401).json({ error: 'invalid_demo_access_token' })
    return
  }

  next()
}
