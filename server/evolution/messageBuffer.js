/**
 * Buffer de mensagens do WhatsApp (equivalente aos nodes Redis do n8n).
 *
 * Três backends, escolhidos automaticamente (na ordem abaixo):
 *   1. Redis     (ioredis)   — se REDIS_URL ou REDIS_HOST estiver configurado
 *                              E a conexão inicial for bem-sucedida.
 *   2. Supabase  (REST)      — se SUPABASE_URL + SUPABASE_KEY estiverem setados.
 *                              Usa a tabela MESSAGE_BUFFER_TABLE (default:
 *                              message_buffer). Persiste, escala multi-réplica
 *                              e é fácil de inspecionar no painel.
 *   3. Memory    (Map)       — fallback: sem infra, não persiste em restart.
 *
 * Tabela esperada no backend Supabase:
 *   CREATE TABLE message_buffer (
 *     id bigserial PRIMARY KEY,
 *     session_id text NOT NULL,
 *     content text NOT NULL,
 *     created_at timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX message_buffer_session_id_idx ON message_buffer (session_id, id);
 *
 * Envs:
 *   REDIS_URL / REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB / REDIS_TLS / REDIS_KEY_PREFIX
 *   SUPABASE_URL / SUPABASE_KEY
 *   MESSAGE_BUFFER_TABLE=message_buffer
 *   MESSAGE_BUFFER_BACKEND=redis|supabase|memory  (força um backend específico)
 */

import Redis from 'ioredis'

const DEFAULT_KEY_PREFIX = 'wa:msg:'
const DEFAULT_TABLE = 'message_buffer'

let backendPromise = null

// ── Redis ────────────────────────────────────────────────────────────────

function hasRedisConfig(env) {
  return Boolean(env.REDIS_URL || env.REDIS_HOST)
}

function buildRedisClient(env) {
  const commonOpts = {
    lazyConnect: true,
    enableAutoPipelining: true,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  }
  if (env.REDIS_URL) return new Redis(env.REDIS_URL, commonOpts)
  return new Redis({
    host: env.REDIS_HOST || '127.0.0.1',
    port: Number(env.REDIS_PORT || 6379),
    password: env.REDIS_PASSWORD || undefined,
    db: Number(env.REDIS_DB || 0),
    tls: String(env.REDIS_TLS || '').toLowerCase() === 'true' ? {} : undefined,
    ...commonOpts,
  })
}

function makeRedisBackend(env) {
  const client = buildRedisClient(env)
  const prefix = env.REDIS_KEY_PREFIX || DEFAULT_KEY_PREFIX
  const keyFor = (sid) => `${prefix}${sid}`

  client.on('error', (err) => {
    console.error('[MessageBuffer][Redis] error:', err.message)
  })

  return {
    label: 'redis',
    async init() {
      await client.connect()
      await client.ping()
    },
    async push(sid, text) {
      await client.rpush(keyFor(sid), String(text))
    },
    async get(sid) {
      const items = await client.lrange(keyFor(sid), 0, -1)
      return Array.isArray(items) ? items : []
    },
    async clear(sid) {
      return client.del(keyFor(sid))
    },
    async ping() {
      return client.ping()
    },
  }
}

// ── Supabase ─────────────────────────────────────────────────────────────

function hasSupabaseConfig(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  return Boolean(url && key)
}

function makeSupabaseBackend(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  const table = env.MESSAGE_BUFFER_TABLE || DEFAULT_TABLE
  const base = `${url}/rest/v1/${encodeURIComponent(table)}`
  const headers = {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
  }

  async function request(method, path, { body, prefer } = {}) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body != null ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Supabase buffer ${method} ${res.status}: ${errText.slice(0, 200)}`)
    }
    const text = await res.text()
    return text ? JSON.parse(text) : null
  }

  return {
    label: 'supabase',
    async init() {
      await request('GET', `?select=id&limit=1`)
    },
    async push(sid, text) {
      await request('POST', '', {
        body: { session_id: String(sid), content: String(text) },
        prefer: 'return=minimal',
      })
    },
    async get(sid) {
      const q = `?session_id=eq.${encodeURIComponent(sid)}&order=id.asc&select=content`
      const rows = await request('GET', q)
      if (!Array.isArray(rows)) return []
      return rows.map((r) => r.content).filter((c) => typeof c === 'string')
    },
    async clear(sid) {
      const q = `?session_id=eq.${encodeURIComponent(sid)}`
      await request('DELETE', q, { prefer: 'return=minimal' })
      return 1
    },
    async ping() {
      await request('GET', `?select=id&limit=1`)
      return 'PONG'
    },
  }
}

// ── Memory ───────────────────────────────────────────────────────────────

function makeMemoryBackend() {
  const store = new Map()
  return {
    label: 'memory',
    async init() {},
    async push(sid, text) {
      const list = store.get(sid) || []
      list.push(String(text))
      store.set(sid, list)
    },
    async get(sid) {
      return (store.get(sid) || []).slice()
    },
    async clear(sid) {
      store.delete(sid)
      return 1
    },
    async ping() {
      return 'PONG'
    },
  }
}

// ── Seleção ──────────────────────────────────────────────────────────────

async function tryInit(backend) {
  await backend.init()
  return backend
}

async function pickBackend(env) {
  const forced = String(env.MESSAGE_BUFFER_BACKEND || '').toLowerCase()

  if (forced === 'memory') {
    console.warn('[MessageBuffer] forçado memory → buffer em memória (não persistente)')
    return makeMemoryBackend()
  }

  if (forced === 'redis') {
    return tryInit(makeRedisBackend(env)).then((b) => {
      console.log('[MessageBuffer] backend=redis (forçado)')
      return b
    })
  }

  if (forced === 'supabase') {
    return tryInit(makeSupabaseBackend(env)).then((b) => {
      console.log('[MessageBuffer] backend=supabase (forçado)')
      return b
    })
  }

  if (hasRedisConfig(env)) {
    try {
      const b = await tryInit(makeRedisBackend(env))
      console.log('[MessageBuffer] backend=redis (auto)')
      return b
    } catch (err) {
      console.warn(`[MessageBuffer] Redis indisponível (${err.message}) → tentando Supabase`)
    }
  }

  if (hasSupabaseConfig(env)) {
    try {
      const b = await tryInit(makeSupabaseBackend(env))
      console.log('[MessageBuffer] backend=supabase (auto)')
      return b
    } catch (err) {
      console.warn(`[MessageBuffer] Supabase indisponível (${err.message}) → caindo para memória`)
    }
  }

  console.warn('[MessageBuffer] nenhum backend externo disponível → usando buffer em memória (não persistente)')
  return makeMemoryBackend()
}

async function getBackend(env) {
  if (!backendPromise) {
    backendPromise = pickBackend(env).catch((err) => {
      backendPromise = null
      throw err
    })
  }
  return backendPromise
}

// ── API pública ──────────────────────────────────────────────────────────

export async function pushMessage(env, sessionId, text) {
  if (!sessionId || !text) return
  const backend = await getBackend(env)
  await backend.push(sessionId, text)
}

export async function getMessages(env, sessionId) {
  if (!sessionId) return []
  const backend = await getBackend(env)
  return backend.get(sessionId)
}

export async function clearMessages(env, sessionId) {
  if (!sessionId) return 0
  const backend = await getBackend(env)
  return backend.clear(sessionId)
}

export async function pingBackend(env) {
  const backend = await getBackend(env)
  return { backend: backend.label, pong: await backend.ping() }
}
