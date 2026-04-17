import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [
    react(),
    supabaseMiddleware(),
  ],
  build: { outDir: 'dist' },
})

function supabaseMiddleware() {
  const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL
  const SUPABASE_KEY = process.env.VITE_SUPABASE_KEY || process.env.SUPABASE_KEY

  return {
    name: 'supabase-proxy',
    configureServer(server) {
      server.middlewares.use('/api/supabase', async (req, res) => {
        const chunks = []
        req.on('data', (c) => chunks.push(c))
        req.on('end', async () => {
          try {
            const body = Buffer.concat(chunks).toString()
            const targetPath = req.url || ''
            const targetUrl = `${SUPABASE_URL}${targetPath}`

            const response = await fetch(targetUrl, {
              method: req.method || 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
              },
              body: req.method !== 'GET' ? body : undefined,
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
