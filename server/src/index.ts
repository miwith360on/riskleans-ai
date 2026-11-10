
import express from 'express'
import cors from 'cors'
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
    environment: 'development',
    message: 'RiskLens AI backend is running!'
  })
})

app.use('/api/paypal', paypalRouter)
app.use('/api/ai', aiRouter)

app.listen(PORT, () => {
  console.log(`RiskLens AI API running at http://${HOST}:${PORT}`)
})
