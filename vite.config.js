import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { startScheduler, getStatus } from './server/feedbackJobRunner.js'
import { runNearestPolo } from './server/locationTool.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      react(),
      supabaseProxyPlugin('/api/supabase', env.SUPABASE_URL || env.VITE_SUPABASE_URL, env.SUPABASE_KEY || env.VITE_SUPABASE_KEY),
      supabaseProxyPlugin('/api/feedback-supabase', env.SUPABASE_URL_FEEDBACK || env.VITE_SUPABASE_URL_FEEDBACK, env.SUPABASE_KEY_FEEDBACK || env.VITE_SUPABASE_KEY_FEEDBACK),
      feedbackJobPlugin(env),
      locationApiPlugin(env),
    ],
    build: { outDir: 'dist' },
  }
})

function locationApiPlugin(env) {
  return {
    name: 'location-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = req.url?.split('?')[0] || ''
        if (path !== '/api/location/nearest-polo') return next()
        if (req.method !== 'POST') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: 'Use POST' }))
          return
        }
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', async () => {
          try {
            const raw = Buffer.concat(chunks).toString()
            const body = raw ? JSON.parse(raw) : {}
            const out = await runNearestPolo(env, body)
            const code = out.ok ? 200 : 400
            res.writeHead(code, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(out))
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: e.message }))
          }
        })
      })
    },
  }
}

function feedbackJobPlugin(env) {
  return {
    name: 'feedback-job',
    configureServer(server) {
      // Liga o scheduler (cron) no dev também, respeitando FEEDBACK_JOB_ENABLED
      startScheduler(env)

      // Endpoint de status
      server.middlewares.use('/api/feedback-job/status', async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: 'Use GET' }))
          return
        }
        try {
          const status = await getStatus(env)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(status))
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: e.message }))
        }
      })
    },
  }
}

function supabaseProxyPlugin(prefix, url, key) {
  return {
    name: `supabase-proxy${prefix}`,
    configureServer(server) {
      server.middlewares.use(prefix, async (req, res) => {
        if (!url || !key) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: `Proxy ${prefix} não configurado (.env)` }))
          return
        }
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks).toString()
            const targetPath = req.url || ''
            const targetUrl = `${url}${targetPath}`
            const headers = {
              'Content-Type': 'application/json',
              'apikey': key,
              'Authorization': `Bearer ${key}`,
            }
            const prefer = req.headers['prefer']
            if (prefer) headers['Prefer'] = prefer

            const response = await fetch(targetUrl, {
              method: req.method || 'POST',
              headers,
              body: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : body,
            })
            const responseBody = await response.text()
            res.writeHead(response.status, {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            })
            res.end(responseBody)
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: e.message }))
          }
        })
      })
    },
  }
}

