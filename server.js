import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 8000

app.use(express.json({ limit: '5mb' }))

// ── Supabase proxy ──

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_KEY

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

// ── Static files ──

app.use(express.static(join(__dirname, 'dist')))
app.get('*path', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`)
  console.log(`[Server] Supabase proxy: ${SUPABASE_URL ? 'active' : 'DISABLED'}`)
})
