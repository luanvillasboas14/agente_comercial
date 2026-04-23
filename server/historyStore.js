/**
 * Histórico da conversa — espelha o subfluxo do N8N em `histórico.txt`.
 *
 * Após o agente responder, gravamos em sequência:
 *
 *   1) chats        — upsert por `phone` (insert se não existir, update `updated_at` se existir).
 *   2) chat_messages— insert { phone, user_message, bot_message, message_type, created_at, id_lead }.
 *   3) face-insta   — insert { id_lead, created_at } SOMENTE quando a user_message é
 *                     "Quero mais informações" ou "👨‍🎓 Quero mais informações".
 *
 * Tudo no Supabase principal (banco da IA). Nomes de tabela são configuráveis:
 *   SUPABASE_CHATS_TABLE          (default: chats)
 *   SUPABASE_CHAT_MESSAGES_TABLE  (default: chat_messages)
 *   SUPABASE_FACE_INSTA_TABLE     (default: face-insta)
 *
 * Formato de data: América/São_Paulo (UTC-3) em ISO — mesmo que o N8N usava com
 * `$now.setZone("America/Sao_Paulo").toISO()`.
 *
 * O delete do buffer (Redis/Supabase) já acontece no flush do webhook
 * (`clearMessages`), então esse módulo não repete esse passo.
 */

import { normalizeTelefone } from './dadosClienteStore.js'

const FACE_INSTA_TRIGGERS = new Set([
  'Quero mais informações',
  '👨‍🎓 Quero mais informações',
])

function getConfig(env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL || ''
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || ''
  return {
    url: url.replace(/\/$/, ''),
    key,
    chatsTable: env.SUPABASE_CHATS_TABLE || 'chats',
    messagesTable: env.SUPABASE_CHAT_MESSAGES_TABLE || 'chat_messages',
    faceInstaTable: env.SUPABASE_FACE_INSTA_TABLE || 'face-insta',
    memoryTable: env.N8N_MEMORY_TABLE || 'n8n_chat_histories',
  }
}

/** ISO com offset -03:00 (equivalente a $now.setZone("America/Sao_Paulo").toISO()). */
function nowSaoPauloISO() {
  const now = new Date()
  const local = new Date(now.getTime() - 3 * 60 * 60 * 1000)
  return local.toISOString().replace('Z', '-03:00')
}

async function sbRequest(url, key, method, pathAndQuery, body) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  }
  const isWrite = method !== 'GET' && method !== 'HEAD'
  if (isWrite) {
    headers['Content-Type'] = 'application/json'
    headers.Prefer = 'return=representation'
  }
  const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  return { ok: res.ok, status: res.status, data, raw: text }
}

function summarizeError({ status, raw }) {
  return typeof raw === 'string' ? raw.slice(0, 400) : `status ${status}`
}

/**
 * Passo 1: upsert manual em `chats` (SELECT → INSERT ou PATCH updated_at).
 */
export async function upsertChatRow(env, telefone) {
  const cfg = getConfig(env)
  if (!cfg.url || !cfg.key) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }
  }
  const fone = normalizeTelefone(telefone)
  if (!fone) return { ok: false, code: 'MISSING_TELEFONE' }

  const enc = encodeURIComponent(fone)
  const now = nowSaoPauloISO()

  const sel = await sbRequest(
    cfg.url,
    cfg.key,
    'GET',
    `${cfg.chatsTable}?phone=eq.${enc}&select=phone&limit=1`,
  )
  if (!sel.ok) {
    return { ok: false, code: 'SUPABASE_SELECT_FAILED', status: sel.status, error: summarizeError(sel) }
  }
  const exists = Array.isArray(sel.data) && sel.data.length > 0

  if (exists) {
    const r = await sbRequest(
      cfg.url,
      cfg.key,
      'PATCH',
      `${cfg.chatsTable}?phone=eq.${enc}`,
      { updated_at: now },
    )
    if (!r.ok) {
      return { ok: false, code: 'SUPABASE_UPDATE_FAILED', status: r.status, error: summarizeError(r) }
    }
    return { ok: true, action: 'updated', phone: fone }
  }

  const r = await sbRequest(
    cfg.url,
    cfg.key,
    'POST',
    cfg.chatsTable,
    { phone: fone, created_at: now, updated_at: now },
  )
  if (!r.ok) {
    return { ok: false, code: 'SUPABASE_INSERT_FAILED', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, action: 'inserted', phone: fone }
}

/**
 * Passo 2: insere uma linha em `chat_messages` com a mensagem do usuário + resposta da IA.
 */
export async function insertChatMessage(env, {
  telefone,
  userMessage,
  botMessage,
  messageType,
  idLead,
  createdAt,
}) {
  const cfg = getConfig(env)
  if (!cfg.url || !cfg.key) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }
  }
  const fone = normalizeTelefone(telefone)
  if (!fone) return { ok: false, code: 'MISSING_TELEFONE' }

  const row = {
    phone: fone,
    user_message: userMessage ?? null,
    bot_message: botMessage ?? null,
    message_type: messageType || 'conversation',
    created_at: createdAt || new Date().toISOString(),
  }
  if (idLead != null && idLead !== '') {
    const n = Number(idLead)
    row.id_lead = Number.isFinite(n) ? n : idLead
  }

  const r = await sbRequest(cfg.url, cfg.key, 'POST', cfg.messagesTable, [row])
  if (!r.ok) {
    return { ok: false, code: 'SUPABASE_INSERT_FAILED', status: r.status, error: summarizeError(r) }
  }
  return {
    ok: true,
    inserted: Array.isArray(r.data) ? r.data.length : 1,
    row: Array.isArray(r.data) ? r.data[0] : null,
  }
}

/**
 * Apêndice de memória: grava as 2 mensagens (human + ai) em n8n_chat_histories
 * no formato esperado pelo LangChain (PostgresChatMemory). É o que o agente lê
 * automaticamente em `runAgent` via `runBuscarHistorico`.
 *
 * session_id é sempre `<digitos>@s.whatsapp.net` (mesmo shape do N8N).
 */
export async function appendChatMemory(env, { telefone, userMessage, botMessage }) {
  const cfg = getConfig(env)
  if (!cfg.url || !cfg.key) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }
  }
  const fone = normalizeTelefone(telefone)
  if (!fone) return { ok: false, code: 'MISSING_TELEFONE' }

  const sessionId = `${fone}@s.whatsapp.net`
  const rows = []
  const human = String(userMessage || '').trim()
  const ai = String(botMessage || '').trim()

  if (human) {
    rows.push({
      session_id: sessionId,
      message: {
        type: 'human',
        data: {
          content: human,
          type: 'human',
          additional_kwargs: {},
          response_metadata: {},
          example: false,
        },
      },
    })
  }
  if (ai) {
    rows.push({
      session_id: sessionId,
      message: {
        type: 'ai',
        data: {
          content: ai,
          type: 'ai',
          additional_kwargs: {},
          response_metadata: {},
          tool_calls: [],
          invalid_tool_calls: [],
        },
      },
    })
  }
  if (!rows.length) {
    return { ok: true, skipped: true, reason: 'no_content' }
  }

  const path = encodeURIComponent(cfg.memoryTable)
  const r = await sbRequest(cfg.url, cfg.key, 'POST', path, rows)
  if (!r.ok) {
    return { ok: false, code: 'SUPABASE_INSERT_FAILED', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, inserted: rows.length, session_id: sessionId }
}

/**
 * Passo 3: grava em `face-insta` somente quando a user_message é um dos gatilhos.
 * Se não bater o gatilho ou faltar id_lead, retorna ok:true com skipped:true.
 */
export async function maybeInsertFaceInsta(env, { userMessage, idLead }) {
  const text = String(userMessage || '').trim()
  if (!FACE_INSTA_TRIGGERS.has(text)) {
    return { ok: true, skipped: true, reason: 'not_trigger' }
  }
  if (idLead == null || idLead === '') {
    return { ok: true, skipped: true, reason: 'missing_id_lead' }
  }
  const cfg = getConfig(env)
  if (!cfg.url || !cfg.key) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED' }
  }

  const n = Number(idLead)
  const row = {
    id_lead: Number.isFinite(n) ? n : idLead,
    created_at: nowSaoPauloISO(),
  }
  const path = encodeURIComponent(cfg.faceInstaTable)
  const r = await sbRequest(cfg.url, cfg.key, 'POST', path, [row])
  if (!r.ok) {
    return { ok: false, code: 'SUPABASE_INSERT_FAILED', status: r.status, error: summarizeError(r) }
  }
  return {
    ok: true,
    triggered: true,
    row: Array.isArray(r.data) ? r.data[0] : null,
  }
}

/**
 * Orquestra os 3 passos do subfluxo. Continua mesmo se um dos passos falhar e
 * devolve um `steps[]` detalhado para debug.
 */
export async function saveConversation(env, params) {
  const {
    telefone,
    userMessage,
    botMessage,
    messageType = 'conversation',
    idLead = null,
  } = params || {}

  const steps = []

  const chatRow = await upsertChatRow(env, telefone)
  steps.push({ step: 'chats', ...chatRow })

  const msg = await insertChatMessage(env, {
    telefone,
    userMessage,
    botMessage,
    messageType,
    idLead,
  })
  steps.push({ step: 'chat_messages', ...msg })

  const fi = await maybeInsertFaceInsta(env, { userMessage, idLead })
  steps.push({ step: 'face_insta', ...fi })

  const mem = await appendChatMemory(env, { telefone, userMessage, botMessage })
  steps.push({ step: 'memory_append', ...mem })

  return {
    ok: chatRow.ok && msg.ok && fi.ok && mem.ok,
    steps,
  }
}
