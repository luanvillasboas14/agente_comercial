import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { startScheduler, getStatus } from './server/feedbackJobRunner.js'
import { runNearestPolo } from './server/locationTool.js'
import { runInscricao } from './server/inscricaoTool.js'
import { runDistribuirHumano } from './server/distribuirHumanoTool.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 8000

app.use(express.json({ limit: '5mb' }))

// ── Supabase proxy (principal - dados da IA) ──

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY

// ── Supabase proxy (feedback comercial) ──

const SUPABASE_URL_FEEDBACK = process.env.SUPABASE_URL_FEEDBACK || process.env.VITE_SUPABASE_URL_FEEDBACK
const SUPABASE_KEY_FEEDBACK = process.env.SUPABASE_KEY_FEEDBACK || process.env.VITE_SUPABASE_KEY_FEEDBACK

function makeSupabaseProxy(url, key, label) {
  return async (req, res) => {
    if (!url || !key) {
      return res.status(500).json({ error: `${label} não configurado` })
    }
    try {
      const prefix = req.baseUrl ? req.baseUrl + '/' : ''
      const fullPath = req.originalUrl.replace(prefix, '')
      const targetUrl = `${url}/${fullPath}`
      const headers = {
        'Content-Type': 'application/json',
        'apikey': key,
        'Authorization': `Bearer ${key}`,
      }
      const prefer = req.headers['prefer']
      if (prefer) headers['Prefer'] = prefer

      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body),
      })
      const body = await response.text()
      res.status(response.status).set('Content-Type', 'application/json').send(body)
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  }
}

app.all('/api/supabase/*path', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'SUPABASE_URL ou SUPABASE_KEY não configurados' })
  }
  try {
    const fullPath = req.originalUrl.replace('/api/supabase/', '')
    const targetUrl = `${SUPABASE_URL}/${fullPath}`

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    }
    const prefer = req.headers['prefer']
    if (prefer) headers['Prefer'] = prefer

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body),
    })
    const body = await response.text()
    res.status(response.status).set('Content-Type', 'application/json').send(body)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.all('/api/feedback-supabase/*path', async (req, res) => {
  if (!SUPABASE_URL_FEEDBACK || !SUPABASE_KEY_FEEDBACK) {
    return res.status(500).json({ error: 'SUPABASE_URL_FEEDBACK ou SUPABASE_KEY_FEEDBACK não configurados' })
  }
  try {
    const fullPath = req.originalUrl.replace('/api/feedback-supabase/', '')
    const targetUrl = `${SUPABASE_URL_FEEDBACK}/${fullPath}`

    const headers = {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY_FEEDBACK,
      'Authorization': `Bearer ${SUPABASE_KEY_FEEDBACK}`,
    }
    const prefer = req.headers['prefer']
    if (prefer) headers['Prefer'] = prefer

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : JSON.stringify(req.body),
    })
    const body = await response.text()
    res.status(response.status).set('Content-Type', 'application/json').send(body)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Feedback Job: scheduler + endpoint de status ──

startScheduler(process.env)

app.get('/api/feedback-job/status', async (_req, res) => {
  try {
    const status = await getStatus(process.env)
    res.json(status)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Tool localização (geocode + polo_loc + Distance Matrix) ──

app.post('/api/location/nearest-polo', async (req, res) => {
  try {
    const out = await runNearestPolo(process.env, req.body || {})
    if (!out.ok) {
      res.status(400).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Tool inscrição (Kommo + Supabase + OpenAI) ──

app.post('/api/inscricao/run', async (req, res) => {
  try {
    const out = await runInscricao(process.env, req.body || {})
    if (!out.ok && (out.code === 'MISSING_CRM_FIELDS' || out.code === 'MISSING_PARAMS')) {
      res.status(400).json(out)
      return
    }
    if (!out.ok) {
      res.status(500).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Tool distribuir_humano (Kommo + 2× Supabase + OpenAI) ──

app.post('/api/distribuir-humano/run', async (req, res) => {
  try {
    const out = await runDistribuirHumano(process.env, req.body || {})
    if (!out.ok && (out.code === 'MISSING_CRM_FIELDS' || out.code === 'LEAD_NOT_ELIGIBLE')) {
      res.status(400).json(out)
      return
    }
    if (!out.ok) {
      res.status(500).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Static files ──

app.use(express.static(join(__dirname, 'dist')))
app.get('*path', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  const maps = process.env.GOOGLE_MAPS_API_KEY || process.env.VITE_GOOGLE_MAPS_API_KEY
  console.log(`[Server] Listening on port ${PORT}`)
  console.log(`[Server] Supabase proxy (IA): ${SUPABASE_URL ? 'active' : 'DISABLED'}`)
  console.log(`[Server] Supabase proxy (Feedback): ${SUPABASE_URL_FEEDBACK ? 'active' : 'DISABLED'}`)
  console.log(`[Server] Location tool (Google Maps): ${maps ? 'active' : 'DISABLED'}`)
  const poloTable = process.env.SUPABASE_POLO_TABLE || process.env.POLO_LOC_TABLE || 'polo_loc'
  const poloHost =
    process.env.SUPABASE_POLO_URL ||
    process.env.SUPABASE_URL_FEEDBACK ||
    process.env.VITE_SUPABASE_URL_FEEDBACK ||
    process.env.SUPABASE_URL ||
    ''
  let poloHostLabel = '—'
  try {
    if (poloHost) poloHostLabel = new URL(poloHost).host
  } catch { /* ignore */ }
  console.log(`[Server] Polos: table=${poloTable} host=${poloHostLabel}`)
}).on('error', (err) => {
  console.error('[Server] Listen error:', err.message)
})
