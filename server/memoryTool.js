/**
 * Memória de conversa (equivalente ao node “Postgres Chat Memory” do n8n).
 *
 * Lê a tabela n8n_chat_histories do Supabase principal usando, como session_id,
 * o telefone do lead no formato `<digitos>@s.whatsapp.net` (o mesmo usado pelo n8n).
 *
 * Formato esperado da coluna `message` (jsonb) — compatível com LangChain:
 *   { type: 'human' | 'ai' | 'system', data: { content: '...' } }
 * Também aceita o formato antigo: { type, content }.
 */

const DEFAULT_TABLE = 'n8n_chat_histories'
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

function normalizeSessionId(telefone) {
  if (telefone == null) return ''
  const raw = String(telefone).trim()
  if (!raw) return ''
  if (raw.includes('@')) return raw
  const digits = raw.replace(/[^0-9]/g, '')
  if (!digits) return ''
  return `${digits}@s.whatsapp.net`
}

function coerceMessage(row) {
  const m = row?.message
  if (!m || typeof m !== 'object') return null

  const type = m.type || m.data?.type || m.role || null
  const contentRaw =
    (typeof m.content === 'string' && m.content) ||
    (typeof m.data?.content === 'string' && m.data.content) ||
    (typeof m.text === 'string' && m.text) ||
    ''

  const content = String(contentRaw || '').trim()
  if (!content) return null

  let role = 'desconhecido'
  if (type === 'human' || type === 'user') role = 'lead'
  else if (type === 'ai' || type === 'assistant') role = 'assistente'
  else if (type === 'system') role = 'system'
  else if (type === 'tool' || type === 'function') role = 'tool'

  return { id: row.id ?? null, role, content }
}

function formatHistoryText(sessionId, mensagens) {
  if (!mensagens.length) {
    return `Sem histórico de conversa para ${sessionId}.`
  }
  const linhas = mensagens.map((m) => {
    const tag = m.role === 'lead' ? 'Lead' : m.role === 'assistente' ? 'Assistente' : m.role
    const texto = m.content.replace(/\s+/g, ' ').trim()
    return `[${tag}] ${texto}`
  })
  return [
    `Histórico da conversa (${mensagens.length} mensagens, mais antigo → mais recente) — sessão ${sessionId}:`,
    ...linhas,
  ].join('\n')
}

export async function runBuscarHistorico(env, body = {}) {
  const SUPABASE_URL = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const SUPABASE_KEY = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return {
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      error: 'SUPABASE_URL/SUPABASE_KEY não configurados no servidor.',
    }
  }

  const sessionId = normalizeSessionId(body?.telefone ?? body?.session_id)
  if (!sessionId) {
    return {
      ok: false,
      code: 'MISSING_PARAMS',
      error: 'Informe o telefone do lead (ex.: 5511998209798) ou o session_id completo.',
    }
  }

  const table = env.N8N_MEMORY_TABLE || DEFAULT_TABLE
  const requestedLimit = Number(body?.limit)
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(MAX_LIMIT, Math.floor(requestedLimit))
    : DEFAULT_LIMIT

  const url = `${SUPABASE_URL}/rest/v1/${encodeURIComponent(table)}?session_id=eq.${encodeURIComponent(sessionId)}&order=id.desc&limit=${limit}`

  try {
    const res = await fetch(url, {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return {
        ok: false,
        code: 'SUPABASE_ERROR',
        status: res.status,
        error: `Supabase ${res.status}: ${errBody.slice(0, 200)}`,
      }
    }
    const rows = await res.json().catch(() => [])
    if (!Array.isArray(rows) || rows.length === 0) {
      return {
        ok: true,
        session_id: sessionId,
        table,
        count: 0,
        mensagens: [],
        historico: `Sem histórico de conversa para ${sessionId}.`,
      }
    }
    rows.reverse()
    const mensagens = rows.map(coerceMessage).filter(Boolean)
    return {
      ok: true,
      session_id: sessionId,
      table,
      count: mensagens.length,
      mensagens,
      historico: formatHistoryText(sessionId, mensagens),
    }
  } catch (e) {
    return { ok: false, code: 'FETCH_ERROR', error: e.message }
  }
}
