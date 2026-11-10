
import express from 'express'
import cors from 'cors'
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import type { NextFunction, Request, Response } from 'express'
import { assertDemoAccessTokenConfigured } from './auth'
import aiRouter from './ai'
import paypalRouter from './paypal'

assertDemoAccessTokenConfigured()

const app = express()
const PORT = Number(process.env.PORT) || 3001
const HOST = process.env.HOST?.trim() || '127.0.0.1'

app.use(cors({
  origin: ['http://localhost:5173', 'http://127.0.0.1:5173']
}))
app.use(express.json({ limit: '10kb' }))
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (
    error instanceof SyntaxError &&
    'type' in error &&
    error.type === 'entity.parse.failed'
  ) {
    res.status(400).json({ error: 'invalid_json' })
    return
  }
  next(error)
})

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'online',
    application: 'RiskLens AI',
    environment: process.env.NODE_ENV === 'production' ? 'production' : 'development',
    message: 'RiskLens AI backend is running!'
  })
})

app.use('/api/paypal', paypalRouter)
app.use('/api/ai', aiRouter)
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' })
})

// In production (e.g. Render) this one server also serves the built dashboard,
// so the whole app runs at a single URL. Locally, Vite serves the dashboard instead.
const clientDist = path.resolve(__dirname, '../../client/dist')
if (fs.existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }))
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      next()
      return
    }
    res.sendFile(path.join(clientDist, 'index.html'))
  })
}

app.listen(PORT, HOST, () => {
  console.log(`RiskLens AI API running at http://${HOST}:${PORT}`)
})
