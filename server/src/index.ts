
import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import aiRouter from './ai'
import paypalRouter from './paypal'

const app = express()
const PORT = Number(process.env.PORT) || 3001

app.use(cors({
  origin: 'http://localhost:5173'
}))
app.use(express.json({ limit: '10kb' }))

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
  console.log(`RiskLens AI API running at http://localhost:${PORT}`)
})
