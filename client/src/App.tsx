import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { AgGridReact } from 'ag-grid-react'
import {
  AllCommunityModule,
  ModuleRegistry,
  colorSchemeDarkBlue,
  themeQuartz,
  type ColDef,
  type RowClassRules,
} from 'ag-grid-community'
import './App.css'
import './ai-investigation.css'

// Register Community modules: sorting, filtering, row selection and grid display.
ModuleRegistry.registerModules([AllCommunityModule])

// Match the original RiskLens AI navy/teal dashboard.
const riskLensGridTheme = themeQuartz.withPart(colorSchemeDarkBlue).withParams({
  backgroundColor: '#111c2d',
  foregroundColor: '#e8edf6',
  headerBackgroundColor: '#142136',
  accentColor: '#53cfc4',
  borderColor: '#263348',
  selectedRowBackgroundColor: '#1d374c',
  rowHoverColor: '#182b40',
  headerTextColor: '#9aacc1',
  fontSize: 12,
  headerFontSize: 11,
  spacing: 8,
})

type RiskLevel = 'High' | 'Medium' | 'Low'
type ViewFilter = 'All' | RiskLevel | 'PayPal'
type TransactionSource = 'demo' | 'paypal_sandbox'
type RiskFactor = { label: string; points: number; detail: string; baseline?: boolean }
type DemoTransaction = {
  id: string
  customer: string
  amount: number
  minutesAgo: number
  paymentsIn10Min: number
  newCustomer: boolean
  outsideHours: boolean
}
type PayPalSandboxCapture = {
  orderId: string
  transactionId: string
  status: 'COMPLETED'
  amount: string
  currency: string
}
type AiInvestigation = {
  summary: string
  observations: Array<{ observation: string; evidence: string }>
  uncertainty: string[]
  recommendedActions: string[]
}
type AiInvestigationResponse = {
  transactionId: string
  source: 'synthetic_demo' | 'paypal_sandbox'
  riskScore: number
  riskLevel: RiskLevel
  investigation: AiInvestigation
}

// Local dev talks to the backend on port 3001. In a production build the
// backend serves this page itself, so API calls go to the same site.
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? (import.meta.env.DEV ? 'http://127.0.0.1:3001' : '')
// One shape for both fictional demo payments and real PayPal Sandbox captures.
// Signals PayPal does not return for a capture are null and are never guessed.
type PaymentRecord = {
  id: string
  customer: string
  amount: number
  currency: string
  minutesAgo: number | null
  paymentsIn10Min: number | null
  newCustomer: boolean | null
  outsideHours: boolean | null
  source: TransactionSource
  orderId?: string
}
type ScoredTransaction = PaymentRecord & {
  riskScore: number
  rawScore: number
  riskLevel: RiskLevel
  factors: RiskFactor[]
}
const BASELINE_POINTS = 5
const REVIEWED_STORAGE_KEY = 'risklens.reviewed.v1'
const sourceLabel = (source: TransactionSource) => source === 'paypal_sandbox' ? 'PayPal Sandbox' : 'Demo'

// These are deliberately fictional demonstration payments, NOT PayPal records.
const demoTransactions: DemoTransaction[] = [
  { id: 'TXN-1042', customer: 'Avery Morgan', amount: 1850, minutesAgo: 2, paymentsIn10Min: 5, newCustomer: true, outsideHours: true },
  { id: 'TXN-1041', customer: 'Northline Studio', amount: 1120, minutesAgo: 8, paymentsIn10Min: 4, newCustomer: false, outsideHours: true },
  { id: 'TXN-1040', customer: 'Crescent Supplies', amount: 640, minutesAgo: 17, paymentsIn10Min: 1, newCustomer: true, outsideHours: false },
  { id: 'TXN-1039', customer: 'Lakeview Market', amount: 84, minutesAgo: 29, paymentsIn10Min: 1, newCustomer: false, outsideHours: false },
  { id: 'TXN-1038', customer: 'Harper Goods', amount: 980, minutesAgo: 38, paymentsIn10Min: 5, newCustomer: false, outsideHours: false },
  { id: 'TXN-1037', customer: 'Orion Crafts', amount: 230, minutesAgo: 51, paymentsIn10Min: 2, newCustomer: true, outsideHours: true },
  { id: 'TXN-1036', customer: 'Jade Coast', amount: 2150, minutesAgo: 79, paymentsIn10Min: 1, newCustomer: true, outsideHours: true },
  { id: 'TXN-1035', customer: 'Botany Box', amount: 49, minutesAgo: 105, paymentsIn10Min: 1, newCustomer: false, outsideHours: false },
  { id: 'TXN-1034', customer: 'Corner Cafe', amount: 138, minutesAgo: 148, paymentsIn10Min: 4, newCustomer: false, outsideHours: false },
  { id: 'TXN-1033', customer: 'Birch Works', amount: 495, minutesAgo: 190, paymentsIn10Min: 1, newCustomer: true, outsideHours: false },
  { id: 'TXN-1032', customer: 'Echo Retail', amount: 750, minutesAgo: 260, paymentsIn10Min: 1, newCustomer: false, outsideHours: true },
  { id: 'TXN-1031', customer: 'Mason Studio', amount: 65, minutesAgo: 340, paymentsIn10Min: 1, newCustomer: false, outsideHours: false },
]

function assessRisk(t: PaymentRecord): ScoredTransaction {
  // Every payment starts with a small baseline so the visible points always add up to the score.
  const factors: RiskFactor[] = [
    { label: 'Baseline', points: BASELINE_POINTS, detail: 'Every payment starts with a small baseline score.', baseline: true },
  ]
  if (t.amount > 1000) {
    factors.push({ label: 'Large payment', points: 38, detail: 'Above the $1,000 threshold.' })
  } else if (t.amount > 500) {
    factors.push({ label: 'Elevated amount', points: 22, detail: 'Above the $500 threshold.' })
  }
  if (t.paymentsIn10Min !== null && t.paymentsIn10Min >= 4) {
    factors.push({ label: 'High payment frequency', points: 28, detail: `${t.paymentsIn10Min} payments in a simulated 10-minute window.` })
  }
  if (t.newCustomer === true) {
    factors.push({ label: 'New customer', points: 18, detail: 'No previous payment history in the demo dataset.' })
  }
  if (t.outsideHours === true) {
    factors.push({ label: 'Outside normal hours', points: 12, detail: 'Flagged as outside normal hours in the demo dataset.' })
  }
  const rawScore = factors.reduce((sum, factor) => sum + factor.points, 0)
  const riskScore = Math.min(100, rawScore)
  const riskLevel: RiskLevel = riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low'
  return { ...t, riskScore, rawScore, riskLevel, factors }
}

const demoScored = demoTransactions
  .map((t): PaymentRecord => ({ ...t, currency: 'USD', source: 'demo' }))
  .map(assessRisk)

function captureToRecord(capture: PayPalSandboxCapture): PaymentRecord {
  return {
    id: capture.transactionId,
    customer: 'PayPal Sandbox payment',
    amount: Number(capture.amount),
    currency: capture.currency,
    minutesAgo: null,
    paymentsIn10Min: null,
    newCustomer: null,
    outsideHours: null,
    source: 'paypal_sandbox',
    orderId: capture.orderId,
  }
}

const money = (amount: number, currency = 'USD') => {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}
const ago = (minutes: number | null) => minutes === null ? '—' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`
const signalCount = (t: ScoredTransaction) => t.factors.filter((factor) => !factor.baseline).length
const breakdown = (t: ScoredTransaction) =>
  t.factors.map((factor) => `${factor.label} +${factor.points}`).join(' · ') +
  (t.rawScore > t.riskScore ? ` = ${t.rawScore}, capped at 100` : ` = ${t.riskScore}`)

function loadReviewed(): Record<string, boolean> {
  try {
    const stored = window.localStorage.getItem(REVIEWED_STORAGE_KEY)
    const parsed: unknown = stored ? JSON.parse(stored) : {}
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value === true)) as Record<string, boolean>
  } catch {
    return {}
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isAiInvestigationResponse(value: unknown): value is AiInvestigationResponse {
  if (
    !isRecord(value) ||
    typeof value.transactionId !== 'string' ||
    (value.source !== 'synthetic_demo' && value.source !== 'paypal_sandbox') ||
    typeof value.riskScore !== 'number' ||
    !['High', 'Medium', 'Low'].includes(String(value.riskLevel)) ||
    !isRecord(value.investigation)
  ) {
    return false
  }

  const investigation = value.investigation
  return typeof investigation.summary === 'string' &&
    Array.isArray(investigation.observations) &&
    investigation.observations.every((item: unknown) =>
      isRecord(item) &&
      typeof item.observation === 'string' &&
      typeof item.evidence === 'string',
    ) &&
    isStringArray(investigation.uncertainty) &&
    isStringArray(investigation.recommendedActions)
}

function aiErrorMessage(payload: unknown, status: number): string {
  const error = isRecord(payload) && typeof payload.error === 'string' ? payload.error : ''
  const upstreamStatus = isRecord(payload) &&
    typeof payload.upstreamStatus === 'number' &&
    Number.isInteger(payload.upstreamStatus)
    ? payload.upstreamStatus
    : status
  const providerCode = isRecord(payload) &&
    typeof payload.providerCode === 'string' &&
    /^[A-Za-z0-9_.-]{1,80}$/.test(payload.providerCode)
    ? ` (OpenAI code: ${payload.providerCode})`
    : ''
  switch (error) {
    case 'demo_access_token_required':
    case 'invalid_demo_access_token':
      return 'Enter a valid demo access token to use protected API features.'
    case 'access_control_not_configured':
      return 'The backend access token is not configured. Set DEMO_ACCESS_TOKEN and restart the backend.'
    case 'ai_usage_limit_reached':
      return 'The configured AI request limit has been reached for this backend process.'
    case 'ai_limits_misconfigured':
      return 'The backend AI request limits are invalid. Check its local configuration.'
    case 'ai_not_configured':
      return 'AI is not configured. Add OPENAI_API_KEY to server/.env and restart the backend.'
    case 'ai_insufficient_quota':
      return 'The OpenAI API project has insufficient quota or reached its billing limit. Check API billing and usage limits.'
    case 'ai_rate_limited':
      return 'The AI provider rate limit was reached. Wait briefly, then try again.'
    case 'ai_authentication_failed':
      return 'OpenAI rejected the API credentials. Verify the key and project configuration in server/.env.'
    case 'ai_model_access_denied':
      return 'The OpenAI project is not permitted to use this model. Check model access and project settings.'
    case 'ai_model_not_found':
      return 'The configured OpenAI model was not found or is unavailable to this project.'
    case 'ai_invalid_request':
      return `OpenAI rejected the investigation request${providerCode}. Check the backend diagnostics.`
    case 'ai_provider_outage':
      return `OpenAI returned a server error (HTTP ${upstreamStatus}). Please try again later.`
    case 'ai_network_error':
      return 'The backend could not connect to OpenAI. Check network access and try again.'
    case 'ai_request_timeout':
      return 'The AI investigation timed out. Please try again.'
    case 'ai_invalid_response':
      return 'The AI provider returned an unusable response. Please try again.'
    case 'ai_response_refused':
      return 'The AI provider declined to generate an investigation. Please try again later.'
    case 'ai_response_incomplete':
      return 'The AI response was incomplete. Please try again.'
    case 'ai_response_invalid_json':
      return 'The AI provider returned malformed structured output. Please try again.'
    case 'ai_response_schema_mismatch':
      return 'The AI response did not match the required investigation format. Please try again.'
    case 'paypal_capture_not_found':
      return 'PayPal could not find this Sandbox capture. Refresh the PayPal captures and try again.'
    case 'paypal_capture_unavailable':
      return 'The backend could not load this capture from PayPal Sandbox. Check the PayPal credentials in server/.env and try again.'
    case 'ai_evidence_mismatch':
      return 'The AI response referenced evidence that was not provided, so it was discarded. Please try again.'
    default:
      return `The AI investigation could not be completed (HTTP ${status}).`
  }
}

function App() {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ViewFilter>('All')
  const [selectedId, setSelectedId] = useState('TXN-1042')
  const [accessTokenDraft, setAccessTokenDraft] = useState('')
  const [demoAccessToken, setDemoAccessToken] = useState('')
  const [reviewed, setReviewed] = useState<Record<string, boolean>>(loadReviewed)
  const [displayedCount, setDisplayedCount] = useState<number | null>(null)
  const gridRef = useRef<AgGridReact<ScoredTransaction>>(null)
  const [sandboxCaptures, setSandboxCaptures] = useState<PayPalSandboxCapture[]>([])
  const [capturesLoading, setCapturesLoading] = useState(false)
  const [capturesError, setCapturesError] = useState('')
  const [captureRefresh, setCaptureRefresh] = useState(0)
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiInvestigation, setAiInvestigation] = useState<AiInvestigationResponse | null>(null)
  const aiRequestController = useRef<AbortController | null>(null)
  const accessTokenInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const controller = new AbortController()

    async function loadSandboxCaptures() {
      if (!demoAccessToken) {
        setSandboxCaptures([])
        setCapturesError('')
        setCapturesLoading(false)
        return
      }

      setCapturesLoading(true)
      setCapturesError('')
      try {
        const response = await fetch(`${API_BASE_URL}/api/paypal/captures`, {
          headers: { Authorization: `Bearer ${demoAccessToken}` },
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`The Sandbox captures API returned HTTP ${response.status}.`)
        }

        const payload: unknown = await response.json()
        if (
          typeof payload !== 'object' ||
          payload === null ||
          !('source' in payload) ||
          payload.source !== 'paypal_sandbox' ||
          !('transactions' in payload) ||
          !Array.isArray(payload.transactions)
        ) {
          throw new Error('The Sandbox captures API returned an invalid response.')
        }

        const captures = payload.transactions.map((capture: unknown): PayPalSandboxCapture => {
          if (
            typeof capture !== 'object' ||
            capture === null ||
            !('orderId' in capture) ||
            typeof capture.orderId !== 'string' ||
            !('transactionId' in capture) ||
            typeof capture.transactionId !== 'string' ||
            !('status' in capture) ||
            capture.status !== 'COMPLETED' ||
            !('amount' in capture) ||
            typeof capture.amount !== 'string' ||
            !('currency' in capture) ||
            typeof capture.currency !== 'string'
          ) {
            throw new Error('The Sandbox captures API returned an invalid transaction.')
          }

          return {
            orderId: capture.orderId,
            transactionId: capture.transactionId,
            status: 'COMPLETED',
            amount: capture.amount,
            currency: capture.currency,
          }
        })
        setSandboxCaptures(captures)
      } catch (error) {
        if (!controller.signal.aborted) {
          setCapturesError(error instanceof Error ? error.message : 'Unable to load Sandbox captures.')
        }
      } finally {
        if (!controller.signal.aborted) {
          setCapturesLoading(false)
        }
      }
    }

    void loadSandboxCaptures()
    return () => controller.abort()
  }, [captureRefresh, demoAccessToken])

  useEffect(() => () => aiRequestController.current?.abort(), [])

  useEffect(() => {
    try {
      window.localStorage.setItem(REVIEWED_STORAGE_KEY, JSON.stringify(reviewed))
    } catch {
      // Storage can be unavailable (private mode); review state still works for this page.
    }
  }, [reviewed])

  function selectTransaction(id: string) {
    aiRequestController.current?.abort()
    setAiLoading(false)
    setAiError('')
    setAiInvestigation(null)
    setSelectedId(id)
  }

  async function investigateSelected() {
    if (!demoAccessToken) {
      setAiError('Paste the value after DEMO_ACCESS_TOKEN= from server/.env into the top bar, then select Connect.')
      accessTokenInput.current?.focus()
      return
    }

    aiRequestController.current?.abort()
    const controller = new AbortController()
    aiRequestController.current = controller
    setAiLoading(true)
    setAiError('')
    setAiInvestigation(null)

    try {
      const response = await fetch(`${API_BASE_URL}/api/ai/investigate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${demoAccessToken}`,
        },
        signal: controller.signal,
        // PayPal rows send only the capture ID: the server fetches the facts from PayPal itself.
        body: JSON.stringify(selected.source === 'paypal_sandbox' ? {
          source: 'paypal_sandbox',
          transactionId: selected.id,
        } : {
          transactionId: selected.id,
          evidence: {
            amount: selected.amount,
            ageMinutes: selected.minutesAgo ?? 0,
            paymentsIn10Minutes: selected.paymentsIn10Min ?? 1,
            newCustomer: selected.newCustomer === true,
            outsideHours: selected.outsideHours === true,
            riskScore: selected.riskScore,
            riskLevel: selected.riskLevel,
          },
        }),
      })
      const payload: unknown = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(aiErrorMessage(payload, response.status))
      }
      if (
        !isAiInvestigationResponse(payload) ||
        payload.transactionId !== selected.id ||
        payload.riskScore !== selected.riskScore ||
        payload.riskLevel !== selected.riskLevel
      ) {
        throw new Error('The AI investigation service returned an invalid response.')
      }
      setAiInvestigation(payload)
    } catch (error) {
      if (!controller.signal.aborted) {
        setAiError(error instanceof TypeError
          ? 'Unable to reach the AI investigation service. Check that the backend is running.'
          : error instanceof Error
            ? error.message
            : 'Unable to reach the AI investigation service. Check that the backend is running.')
      }
    } finally {
      if (!controller.signal.aborted) {
        setAiLoading(false)
      }
    }
  }

  // AG Grid Community provides actual column sorting, filtering and resizing.
  // Recreate column definitions when review state changes so the badges refresh.
  const columnDefs = useMemo<ColDef<ScoredTransaction>[]>(() => [
    {
      field: 'customer',
      headerName: 'TRANSACTION',
      flex: 2,
      minWidth: 185,
      filter: 'agTextColumnFilter',
      getQuickFilterText: (params) => params.data ? `${params.data.customer} ${params.data.id} ${params.data.orderId ?? ''}` : '',
      cellRenderer: (params: { data?: ScoredTransaction }) => params.data ? (
        <div className="grid-customer">
          <strong>{params.data.customer}</strong>
          <span>{params.data.id} · {sourceLabel(params.data.source)}</span>
        </div>
      ) : null,
    },
    { field: 'id', headerName: 'TRANSACTION ID', hide: true },
    {
      field: 'source',
      headerName: 'SOURCE',
      minWidth: 130,
      flex: 1,
      filter: 'agTextColumnFilter',
      valueGetter: (params) => params.data ? sourceLabel(params.data.source) : '',
      cellRenderer: (params: { data?: ScoredTransaction }) => params.data ? (
        <span className={`source-badge ${params.data.source === 'paypal_sandbox' ? 'paypal' : 'demo'}`}>
          {params.data.source === 'paypal_sandbox' ? '● PayPal Sandbox' : 'Demo'}
        </span>
      ) : null,
    },
    {
      field: 'amount',
      headerName: 'AMOUNT',
      minWidth: 115,
      flex: 1,
      filter: 'agNumberColumnFilter',
      valueFormatter: (params) => money(Number(params.value ?? 0), params.data?.currency),
    },
    {
      field: 'minutesAgo',
      headerName: 'TIME',
      minWidth: 100,
      flex: 1,
      filter: 'agNumberColumnFilter',
      valueFormatter: (params) => ago(params.value ?? null),
      headerTooltip: 'Sorts and filters by minutes since payment. PayPal captures show — because timing is not used for scoring.',
    },
    {
      field: 'riskScore',
      headerName: 'RISK SCORE',
      minWidth: 127,
      flex: 1,
      filter: 'agNumberColumnFilter',
      sort: 'desc',
      headerTooltip: 'Hover a score to see how its points add up',
      tooltipValueGetter: (params) => params.data ? breakdown(params.data) : '',
      cellRenderer: (params: { data?: ScoredTransaction }) => params.data ? (
        <div className="score-cell">
          <span className={`score-dot ${params.data.riskLevel.toLowerCase()}`} />
          <strong>{params.data.riskScore}</strong><span>/100</span>
        </div>
      ) : null,
    },
    {
      headerName: 'STATUS',
      colId: 'reviewStatus',
      minWidth: 116,
      flex: 1,
      valueGetter: (params) => !params.data ? '' : reviewed[params.data.id] ? 'Reviewed' : params.data.riskLevel,
      filter: 'agTextColumnFilter',
      cellRenderer: (params: { data?: ScoredTransaction }) => {
        if (!params.data) return null
        const status = reviewed[params.data.id] ? 'Reviewed' : params.data.riskLevel
        return <span className={`status ${status.toLowerCase()}`}>{status}</span>
      },
    },
  ], [reviewed])

  const defaultColDef = useMemo<ColDef<ScoredTransaction>>(() => ({
    sortable: true,
    filter: true,
    resizable: true,
  }), [])

  // Highlight unreviewed high-risk rows and mark real PayPal rows.
  const rowClassRules = useMemo<RowClassRules<ScoredTransaction>>(() => ({
    'row-high-unreviewed': (params) => params.data?.riskLevel === 'High' && !reviewed[params.data.id],
    'row-paypal': (params) => params.data?.source === 'paypal_sandbox',
  }), [reviewed])

  function exportCsv() {
    gridRef.current?.api.exportDataAsCsv({
      fileName: 'risklens-payments.csv',
      allColumns: true,
      processCellCallback: (params) => {
        if (params.column.getColId() === 'reviewStatus' || params.column.getColId() === 'source') {
          return String(params.value ?? '')
        }
        return params.value === null || params.value === undefined ? '' : String(params.value)
      },
    })
  }

  const captureColumnDefs = useMemo<ColDef<PayPalSandboxCapture>[]>(() => [
    { field: 'transactionId', headerName: 'PAYPAL TRANSACTION ID', minWidth: 210, flex: 2, filter: 'agTextColumnFilter' },
    { field: 'orderId', headerName: 'ORDER ID', minWidth: 185, flex: 2, filter: 'agTextColumnFilter' },
    {
      field: 'amount',
      headerName: 'AMOUNT',
      minWidth: 115,
      flex: 1,
      filter: 'agNumberColumnFilter',
      valueGetter: (params) => Number(params.data?.amount ?? 0),
      valueFormatter: (params) => params.data ? `${params.data.amount} ${params.data.currency}` : '',
    },
    { field: 'currency', headerName: 'CURRENCY', minWidth: 105, flex: 1, filter: 'agTextColumnFilter' },
    {
      field: 'status',
      headerName: 'CAPTURE STATUS',
      minWidth: 145,
      flex: 1,
      filter: 'agTextColumnFilter',
      cellRenderer: (params: { value?: string }) => (
        <span className="status completed">{params.value}</span>
      ),
    },
  ], [])
  const captureDefaultColDef = useMemo<ColDef<PayPalSandboxCapture>>(() => ({
    sortable: true,
    filter: true,
    resizable: true,
  }), [])


  const scoredTransactions = useMemo(
    () => [...sandboxCaptures.map(captureToRecord).map(assessRisk), ...demoScored]
      .sort((a, b) => b.riskScore - a.riskScore),
    [sandboxCaptures],
  )
  const paypalCount = scoredTransactions.filter((t) => t.source === 'paypal_sandbox').length

  // Search uses AG Grid's quick filter; the sidebar/risk menu narrows the row set.
  const filtered = useMemo(() => scoredTransactions.filter((t) =>
    filter === 'All' ? true : filter === 'PayPal' ? t.source === 'paypal_sandbox' : t.riskLevel === filter,
  ), [scoredTransactions, filter])

  const selected = scoredTransactions.find((t) => t.id === selectedId) ?? scoredTransactions[0]
  const countByRisk = (level: RiskLevel) => scoredTransactions.filter((t) => t.riskLevel === level).length
  const totalVolume = scoredTransactions.reduce((total, t) => total + t.amount, 0)
  const needsReview = scoredTransactions.filter((t) => t.riskLevel !== 'Low' && !reviewed[t.id]).length
  const today = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date())
  const currentCount = scoredTransactions.length

  const chooseFilter = (value: ViewFilter) => {
    setFilter(value)
    setSearch('')
  }

  function connectDemoAccess(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const token = accessTokenDraft.trim()
    if (token) {
      setDemoAccessToken(token)
      setAccessTokenDraft('')
      setAiError('')
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">◇</div>
          <div><strong>RiskLens<span> AI</span></strong><small>PAYMENT INTELLIGENCE</small></div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="Main navigation" className="nav">
          <button className={filter === 'All' ? 'nav-item active' : 'nav-item'} onClick={() => chooseFilter('All')}><span>◫</span> Overview</button>
          <button className={filter === 'High' ? 'nav-item active' : 'nav-item'} onClick={() => chooseFilter('High')}><span>⚑</span> High-risk payments <em>{countByRisk('High')}</em></button>
          <button className={filter === 'Medium' ? 'nav-item active' : 'nav-item'} onClick={() => chooseFilter('Medium')}><span>◈</span> Medium-risk payments</button>
          <button className={filter === 'PayPal' ? 'nav-item active' : 'nav-item'} onClick={() => chooseFilter('PayPal')}><span>●</span> PayPal Sandbox <em className="paypal-count">{paypalCount}</em></button>
        </nav>
        <div className="sidebar-bottom">
          <div className="demo-status"><span className="pulse-dot"/> Demo environment</div>
          <p>12 fictional demo payments plus real PayPal Sandbox captures, all scored by the same transparent rules.</p>
          <span className="version">RiskLens AI · Hackathon MVP v0.1</span>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">Workspace <span>/</span> Risk overview</div>
          <div className="topbar-right">
            <form className="access-token-form" onSubmit={connectDemoAccess}>
              {!demoAccessToken ? (
                <>
                  <label className="sr-only" htmlFor="demo-access-token">Demo access token</label>
                  <input
                    id="demo-access-token"
                    ref={accessTokenInput}
                    type="password"
                    autoComplete="off"
                    value={accessTokenDraft}
                    onChange={(event) => setAccessTokenDraft(event.target.value)}
                    placeholder="Paste value after DEMO_ACCESS_TOKEN="
                    title="Paste only the value after DEMO_ACCESS_TOKEN= in server/.env"
                    aria-label="Demo access token"
                  />
                  <button type="submit" disabled={!accessTokenDraft.trim()}>Connect</button>
                </>
              ) : (
                <>
                  <span className="access-token-connected">API connected</span>
                  <button
                    type="button"
                    onClick={() => {
                      setDemoAccessToken('')
                      setAiInvestigation(null)
                      setAiError('')
                    }}
                  >
                    Disconnect
                  </button>
                </>
              )}
            </form>
            <span className="mode-pill">● SYNTHETIC + SANDBOX</span><span>{today}</span>
          </div>
        </header>

        <section className="page-intro">
          <div>
            <div className="eyebrow">MERCHANT RISK COMMAND CENTER</div>
            <h1>Spot the unusual.<br/><span>Know what matters.</span></h1>
            <p>Understand payment anomalies through transparent scoring and evidence you can inspect.</p>
          </div>
          <div className="intro-decoration" aria-hidden="true"><span>◇</span><span className="ring"/></div>
        </section>

        <section className="stats-grid" aria-label="Summary metrics">
          <article className="stat-card"><div className="stat-label">Payment volume <span>↗</span></div><strong>{money(totalVolume)}</strong><small>{demoScored.length} demo + {paypalCount} PayPal Sandbox</small></article>
          <article className="stat-card"><div className="stat-label">High-risk flags <span className="stat-icon red">!</span></div><strong>{countByRisk('High')}</strong><small>Require closer inspection</small></article>
          <article className="stat-card"><div className="stat-label">Needs review <span className="stat-icon gold">◎</span></div><strong>{needsReview}</strong><small>High + medium, not marked reviewed</small></article>
          <article className="stat-card"><div className="stat-label">Reviewed cases <span className="stat-icon green">✓</span></div><strong>{Object.values(reviewed).filter(Boolean).length}</strong><small>Saved in this browser</small></article>
        </section>

        <section className="workspace-grid">
          <div className="workspace-left">
            <article className="panel risk-overview">
              <div className="panel-heading"><div><div className="eyebrow">RISK DISTRIBUTION</div><h2>Payment signals</h2></div><span className="panel-note">Rule-based demo</span></div>
              <div className="distribution-grid">
                {(['High', 'Medium', 'Low'] as RiskLevel[]).map((level) => (
                  <button key={level} className={`distribution-row ${filter === level ? 'selected' : ''}`} onClick={() => chooseFilter(level)}>
                    <span className={`risk-dot ${level.toLowerCase()}`}/><span>{level} risk</span>
                    <div className="meter-track"><div className={`meter-fill ${level.toLowerCase()}`} style={{ width: `${(countByRisk(level) / currentCount) * 100}%` }}/></div>
                    <strong>{countByRisk(level)}</strong>
                  </button>
                ))}
              </div>
              <p className="panel-footnote">Scores use four illustrative rules and are <strong>not</strong> validated fraud probabilities.</p>
            </article>

            <article className="panel table-panel">
              <div className="panel-heading table-heading"><div><div className="eyebrow">DEMO + PAYPAL SANDBOX</div><h2>Payment activity</h2></div><div className="grid-actions"><span className="panel-note">{displayedCount ?? filtered.length} shown</span><button type="button" className="export-button" onClick={exportCsv}>Export CSV</button></div></div>
              <div className="table-tools">
                <label className="search-box"><span aria-hidden="true">⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search customer or transaction ID" aria-label="Search transactions" /></label>
                <label className="filter-box">Risk <select value={filter} onChange={(e) => setFilter(e.target.value as ViewFilter)} aria-label="Filter by risk"><option>All</option><option>High</option><option>Medium</option><option>Low</option><option value="PayPal">PayPal Sandbox</option></select></label>
              </div>
              <div className="risk-grid-wrapper" aria-label="AG Grid transaction investigator">
                <AgGridReact<ScoredTransaction>
                  ref={gridRef}
                  theme={riskLensGridTheme}
                  rowData={filtered}
                  columnDefs={columnDefs}
                  defaultColDef={defaultColDef}
                  quickFilterText={search}
                  rowClassRules={rowClassRules}
                  tooltipShowDelay={200}
                  onModelUpdated={(event) => setDisplayedCount(event.api.getDisplayedRowCount())}
                  getRowId={(params) => params.data.id}
                  rowSelection={{ mode: 'singleRow', checkboxes: false, enableClickSelection: true }}
                  onRowClicked={(event) => { if (event.data) selectTransaction(event.data.id) }}
                  rowHeight={56}
                  headerHeight={43}
                  animateRows
                />
              </div>
              <div className="table-footer">Click any row to investigate. Sort or filter from any column header, and hover a score to see how its points add up. PayPal Sandbox rows are real captures; Demo rows are fictional.</div>
            </article>
          </div>

          <aside className="panel details-panel" aria-label="Investigation details">
            <div className="panel-heading"><div><div className="eyebrow">INVESTIGATION</div><h2>Transaction details</h2></div><span className="detail-symbol">◎</span></div>
            <div className="detail-customer"><small>SELECTED PAYMENT</small><h3>{selected.customer}</h3><div className="detail-meta">{selected.id} · {selected.source === 'paypal_sandbox' ? `PayPal Sandbox capture · Order ${selected.orderId}` : 'Demo transaction'}</div></div>
            <div className="detail-amount">{money(selected.amount, selected.currency)}</div>
            <div className="score-box"><div><span>ANOMALY SCORE</span><strong>{selected.riskScore}<small>/100</small></strong></div><span className={`large-risk-badge ${selected.riskLevel.toLowerCase()}`}>{selected.riskLevel} signal</span></div>
            <div className="detail-section"><h3>How the score adds up</h3>
              {selected.factors.map((factor) => (
                <div className={`factor-item ${factor.baseline ? 'baseline' : ''}`} key={factor.label}><div className="factor-icon">+</div><div><strong>{factor.label} <span>+{factor.points}</span></strong><p>{factor.detail}</p></div></div>
              ))}
              {signalCount(selected) === 0 && <p className="no-factors">No unusual signals under the rules.</p>}
              <p className="score-total">Total: {selected.rawScore}{selected.rawScore > selected.riskScore ? ' → capped at 100' : ''}</p>
              {selected.source === 'paypal_sandbox' && (
                <p className="no-factors">PayPal capture data has no payment history, timing window or customer tenure, so those rules are not applied rather than guessed.</p>
              )}
            </div>
            <div className="explain-box"><div className="explain-title">✧ Evidence summary</div><p>{signalCount(selected) ? `This ${selected.source === 'paypal_sandbox' ? 'PayPal Sandbox' : 'fictional'} payment has ${signalCount(selected)} noteworthy indicator${signalCount(selected) > 1 ? 's' : ''} under the rules.` : `This ${selected.source === 'paypal_sandbox' ? 'PayPal Sandbox' : 'fictional'} payment did not trigger any unusual-payment indicators.`} No real customer history or device information is available.</p><small>Deterministic summary · score is not a fraud probability</small></div>
            <section className="ai-investigation" aria-label="AI investigation">
              <button
                className="ai-investigate-button"
                type="button"
                onClick={() => void investigateSelected()}
                disabled={aiLoading}
                aria-busy={aiLoading}
              >
                {aiLoading
                  ? <><span className="ai-spinner" aria-hidden="true" /> Investigating…</>
                  : demoAccessToken ? '✧ Investigate with AI' : 'Connect to investigate with AI'}
              </button>
              <p className="ai-disclaimer">{selected.source === 'paypal_sandbox'
                ? 'The server fetches this capture directly from PayPal Sandbox; the AI sees only PayPal-returned facts, never IDs or customer details.'
                : 'Uses only synthetic demo evidence.'}{demoAccessToken ? '' : ' To connect, paste the value after DEMO_ACCESS_TOKEN= from server/.env in the top bar.'} Advisory only; no PayPal action is taken.</p>
              {aiLoading && <p className="ai-message" role="status">Requesting a grounded review from the configured AI provider…</p>}
              {aiError && <p className="ai-message error" role="alert">{aiError}</p>}
              {aiInvestigation && (
                <div className="ai-result" aria-live="polite">
                  <h3>AI investigation</h3>
                  <p>{aiInvestigation.investigation.summary}</p>
                  <h4>Evidence-supported observations</h4>
                  {aiInvestigation.investigation.observations.length ? (
                    <ul>{aiInvestigation.investigation.observations.map((item, index) => (
                      <li key={`${item.evidence}-${index}`}>
                        <span>{item.observation}</span>
                        <small>Evidence: {item.evidence}</small>
                      </li>
                    ))}</ul>
                  ) : <p>No additional observations were returned.</p>}
                  <h4>Uncertainty / missing information</h4>
                  {aiInvestigation.investigation.uncertainty.length ? (
                    <ul>{aiInvestigation.investigation.uncertainty.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
                  ) : <p>None noted.</p>}
                  <h4>Suggested human review</h4>
                  {aiInvestigation.investigation.recommendedActions.length ? (
                    <ul>{aiInvestigation.investigation.recommendedActions.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul>
                  ) : <p>No additional review steps were suggested.</p>}
                  <small className="ai-result-note">Existing deterministic score: {aiInvestigation.riskScore}/100 ({aiInvestigation.riskLevel}). This is not a fraud determination.</small>
                </div>
              )}
            </section>
            <button className={`review-button ${reviewed[selected.id] ? 'is-reviewed' : ''}`} onClick={() => setReviewed((prev) => ({ ...prev, [selected.id]: !prev[selected.id] }))}>{reviewed[selected.id] ? '✓ Marked reviewed · Undo' : '✓ Mark transaction reviewed'}</button>
            <p className="review-footnote">Review status is saved in this browser.</p>
          </aside>
        </section>
        <section className="panel capture-panel" aria-label="Verified PayPal Sandbox captures">
          <div className="panel-heading">
            <div><div className="eyebrow">PAYPAL SANDBOX · VERIFIED</div><h2>Completed captures</h2></div>
            <div className="capture-panel-actions">
              <span className="panel-note">{sandboxCaptures.length} verified</span>
              <button className="capture-refresh" type="button" onClick={() => setCaptureRefresh((value) => value + 1)} disabled={capturesLoading || !demoAccessToken}>
                {capturesLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>
          <p className="capture-disclaimer">Raw completed captures returned by the PayPal Orders API. Each one is also scored in Payment activity above; no customer details are inferred.</p>
          {capturesError ? (
            <div className="capture-message error" role="alert">
              <span>{capturesError}</span>
              <button className="capture-refresh" type="button" onClick={() => setCaptureRefresh((value) => value + 1)}>Try again</button>
            </div>
          ) : !demoAccessToken ? (
            <p className="capture-message">Enter your demo access token above to view verified Sandbox captures.</p>
          ) : capturesLoading ? (
            <p className="capture-message" role="status">Loading verified Sandbox captures…</p>
          ) : sandboxCaptures.length === 0 ? (
            <p className="capture-message">No completed Sandbox captures were found for the configured orders.</p>
          ) : (
            <div className="risk-grid-wrapper capture-grid" aria-label="AG Grid verified PayPal Sandbox captures">
              <AgGridReact<PayPalSandboxCapture>
                theme={riskLensGridTheme}
                rowData={sandboxCaptures}
                columnDefs={captureColumnDefs}
                defaultColDef={captureDefaultColDef}
                getRowId={(params) => params.data.transactionId}
                rowHeight={56}
                headerHeight={43}
                animateRows
              />
            </div>
          )}
        </section>
        <footer className="app-footer">RiskLens AI · PayPal AI Hackathon prototype · Demo signals are not financial or fraud determinations</footer>
      </main>
    </div>
  )
}

export default App
