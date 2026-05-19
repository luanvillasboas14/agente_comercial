import express from 'express'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { startScheduler, getStatus } from './server/feedbackJobRunner.js'
import { reapStaleFeedbackRuns } from './server/feedbackJob.js'
import { runNearestPolo } from './server/locationTool.js'
import { runInscricao } from './server/inscricaoTool.js'
import { runDistribuirHumano } from './server/distribuirHumanoTool.js'
import { runBuscarHistorico } from './server/memoryTool.js'
import { marcarClienteIA, updateDadosCliente, getLeadIdByTelefone } from './server/dadosClienteStore.js'
import { saveConversation } from './server/historyStore.js'
import { withSessionLock } from './server/evolution/concurrency.js'
import { findLeadByPhone, createLeadNote } from './server/kommoClient.js'
import { sendMessageWithNote, sendText, splitMessage } from './server/whatsappSender.js'
import { generateExecutionId, saveExecution } from './server/ai/executionTelemetry.js'
import { sendTyping } from './server/evolution/typingIndicator.js'
import { makeEvolutionWebhookHandler } from './server/evolution/webhookEvolution.js'
import { transcribeAudioBase64, analyzeImageBase64 } from './server/evolution/openaiMedia.js'
import { fetchEvolutionMediaBase64 } from './server/evolution/evolutionMedia.js'
import { downloadUrlAsBase64 } from './server/mediaDownloader.js'
import { recordWebhookIngress, getWebhookDiagnosticsSnapshot } from './server/evolution/webhookDiagnostics.js'
import { forwardEvolutionWebhook, getForwarderSnapshot } from './server/evolution/webhookForwarder.js'
import { getKommoPollSnapshot } from './server/kommoInboundDiagnostics.js'
import { getModelRegistrySnapshot, resolveModel } from './server/ai/modelRegistry.js'
import {
  listLeadNotes,
  listLeadEvents,
  listLeadCustomFields,
  tryListTalksForLead,
  getTalkById,
  getLeadContactIds,
  listContactChats,
} from './server/kommoClient.js'
import { fetchAmojoChatHistory } from './server/kommoAmojoHistory.js'
import {
  getMessagesByLead as dispatcherGetMessagesByLead,
  checkDispatcherHealth,
} from './server/kommoDispatcherClient.js'
import { pingBackend, pushMessage, getMessages, clearMessages } from './server/evolution/messageBuffer.js'
import { getDebounceMs } from './server/evolution/debouncer.js'
import { runAgent } from './server/ai/agentRunner.js'
import { startAgentScheduler, runSchedulerTick, isSchedulerRunning } from './server/agentScheduler.js'
import { maybeFallbackPollModeWhenDispatcherDown, normalizeKommoInboundPollMode } from './server/kommoInboundPoll.js'
import { runSalesbotCsv, extractLeadIdFromWebhookBody, probePos } from './server/salesbot/csvSearch.js'
import { saveSalesbotExecution } from './server/salesbot/telemetry.js'
import { reindexPos } from './server/salesbot/reindexPos.js'
import { reindexPerguntas } from './server/ai/reindexPerguntas.js'
import { startIaFeedbackRunner, getIaFeedbackRunnerStatus } from './server/iaFeedbackRunner.js'
import { evaluateLead } from './server/iaFeedbackJob.js'
import { seedInitialVersionIfEmpty, getActiveVersion, listVersions, getVersionById, createVersionAndActivate, rollbackToVersion } from './server/iaFeedback/promptVersionStore.js'
import { createProposal, listProposals, getProposalById, markProposalApplied, markProposalRejected } from './server/iaFeedback/proposalsStore.js'
import { getViolationsRanking } from './server/iaFeedback/violationsRanking.js'
import { analyzeRule } from './server/iaFeedback/promptAnalyzer.js'
import { refreshAgentRulesText, getFallbackAgentRulesText } from './server/ai/promptsLoader.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const app = express()
const PORT = process.env.PORT || 8000

app.use(express.json({ limit: '25mb' }))
// O webhook do amocrm/Kommo manda como application/x-www-form-urlencoded
// com chaves em bracket notation (`leads[add][0][id]`). Precisamos de
// `extended: true` pra Express desserializar isso em objeto aninhado.
app.use(express.urlencoded({ extended: true, limit: '2mb' }))

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

// Marca como erro qualquer run preso em 'Executando...' há mais de
// `max_age_minutes` (default 90 min). Útil quando a UI mostra runs
// antigos que ficaram travados por crash do processo / deploy.
app.post('/api/feedback-job/reap-stale', async (req, res) => {
  try {
    const out = await reapStaleFeedbackRuns(process.env, req.body?.max_age_minutes)
    res.json({ ok: true, ...out })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
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

// ── Tool memória (n8n_chat_histories no Supabase principal) ──

app.post('/api/memory/history', async (req, res) => {
  try {
    const out = await runBuscarHistorico(process.env, req.body || {})
    if (!out.ok && (out.code === 'MISSING_PARAMS' || out.code === 'SUPABASE_NOT_CONFIGURED')) {
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

// ── Store: dados_cliente (Supabase principal) ──
//    Node "Atualizar Cliente" do N8N: seta teste_AB='IA' + id_lead por telefone.

app.post('/api/clientes/marcar-ia', async (req, res) => {
  try {
    const { telefone, id_lead, idLead } = req.body || {}
    const out = await marcarClienteIA(process.env, {
      telefone,
      idLead: id_lead ?? idLead,
    })
    if (!out.ok) {
      const http = ['MISSING_TELEFONE', 'MISSING_ID_LEAD', 'MISSING_FIELDS', 'SUPABASE_NOT_CONFIGURED'].includes(out.code) ? 400 : 500
      res.status(http).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// UPDATE genérico na mesma tabela — útil para os próximos nodes do fluxo.
app.post('/api/clientes/update', async (req, res) => {
  try {
    const { telefone, fields } = req.body || {}
    const out = await updateDadosCliente(process.env, { telefone, fields })
    if (!out.ok) {
      const http = ['MISSING_TELEFONE', 'MISSING_FIELDS', 'SUPABASE_NOT_CONFIGURED'].includes(out.code) ? 400 : 500
      res.status(http).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Histórico da conversa (chats + chat_messages + face-insta) ──

app.post('/api/history/save', async (req, res) => {
  try {
    const { telefone, user_message, userMessage, bot_message, botMessage, message_type, messageType, id_lead, idLead } = req.body || {}
    const out = await saveConversation(process.env, {
      telefone,
      userMessage: userMessage ?? user_message,
      botMessage: botMessage ?? bot_message,
      messageType: messageType ?? message_type,
      idLead: idLead ?? id_lead,
    })
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Kommo: busca lead por telefone + nota avulsa ──

app.get('/api/kommo/lead-by-phone', async (req, res) => {
  try {
    const telefone = req.query?.telefone || req.query?.phone
    if (!telefone) {
      res.status(400).json({ ok: false, error: 'telefone é obrigatório' })
      return
    }
    const out = await findLeadByPhone(process.env, telefone)
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/kommo/lead-note', async (req, res) => {
  try {
    const { leadId, id_lead, text } = req.body || {}
    const id = leadId ?? id_lead
    if (!id || !text) {
      res.status(400).json({ ok: false, error: 'leadId e text são obrigatórios' })
      return
    }
    const out = await createLeadNote(process.env, id, text)
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── WhatsApp Cloud API (Meta/WACA): envio + nota no Kommo ──
//    Espelha o fluxo do `envio mensagem.txt` do N8N.

app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { telefone, phone, text, message, leadId, id_lead, executionId } = req.body || {}
    const to = telefone ?? phone
    const body = text ?? message
    if (!to || !body) {
      res.status(400).json({ ok: false, error: 'telefone e text são obrigatórios' })
      return
    }
    const out = await sendMessageWithNote(process.env, {
      telefone: to,
      text: body,
      leadId: leadId ?? id_lead,
      executionId,
    })
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Só envio (sem nota), útil pra testar credenciais da Cloud API rapidinho.
app.post('/api/whatsapp/send-text', async (req, res) => {
  try {
    const { telefone, phone, text, message } = req.body || {}
    const to = telefone ?? phone
    const body = text ?? message
    if (!to || !body) {
      res.status(400).json({ ok: false, error: 'telefone e text são obrigatórios' })
      return
    }
    const out = await sendText(process.env, { to, text: body })
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Preview do smartSplit — não chama a API, só mostra como uma mensagem seria dividida.
app.post('/api/whatsapp/split-preview', (req, res) => {
  try {
    const { text, message, maxChars } = req.body || {}
    const body = text ?? message
    if (!body) {
      res.status(400).json({ ok: false, error: 'text é obrigatório' })
      return
    }
    const n = Number(maxChars || process.env.WHATSAPP_MAX_CHARS || 1000)
    const parts = splitMessage(body, n)
    res.json({ ok: true, total: parts.length, maxChars: n, parts })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Evolution: typing/presence indicator ──

app.post('/api/evolution/typing', async (req, res) => {
  try {
    const { jid, telefone, presence, delayMs } = req.body || {}
    const target = jid || telefone
    if (!target) {
      res.status(400).json({ ok: false, error: 'jid (ou telefone) é obrigatório' })
      return
    }
    const out = await sendTyping(process.env, { jid: target, presence, delayMs })
    res.status(out.ok ? 200 : 500).json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Webhook Evolution (classifica, transcreve, analisa, debounce, chama IA) ──

function evolutionWebhookIngress(req, res, next) {
  const b = req.body
  const n = b && typeof b === 'object' && !Array.isArray(b) ? Object.keys(b).length : 0
  recordWebhookIngress({ bodyKeyCount: n, contentType: req.headers['content-type'] || '' })
  console.log(`[Evolution][ingress] POST bodyKeys=${n} content-type=${req.headers['content-type'] || ''}`)
  // Repassa o payload para URLs externas (n8n, etc.) antes de processar a IA.
  // Fire-and-forget: falhas não afetam o fluxo da IA nem a resposta ao lead.
  forwardEvolutionWebhook(process.env, req.body)
  next()
}

app.post('/api/evolution/webhook', evolutionWebhookIngress, makeEvolutionWebhookHandler(process.env))

// Health-check da WhatsApp Cloud API (Meta). Faz uma chamada GET
// no endpoint da Graph API só pra validar que o phone_number_id e o
// access_token estão corretos — sem enviar mensagem.
//
//   GET /api/whatsapp/health
//
// Retorna:
//   - configured: true se as 2 envs estão setadas
//   - reachable: true se o endpoint Meta respondeu 200
//   - displayPhoneNumber, qualityRating, verifiedName: dados do número
//   - error: mensagem específica quando algo dá errado (token vencido,
//            número errado, etc.)
//
// A Meta não tem endpoint "ping" oficial — usamos o GET no
// /<phone_number_id>?fields=display_phone_number,quality_rating,
// verified_name que retorna metadata do número e valida o token.
app.get('/api/whatsapp/health', async (_req, res) => {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || ''
  const token = process.env.WHATSAPP_ACCESS_TOKEN || ''
  const apiVersion = process.env.WHATSAPP_API_VERSION || 'v19.0'
  const out = {
    configured: Boolean(phoneId && token),
    phoneNumberIdMasked: phoneId ? `${phoneId.slice(0, 4)}…${phoneId.slice(-4)}` : null,
    accessTokenMasked: token ? `${token.slice(0, 6)}…${token.slice(-4)} (${token.length} chars)` : null,
    apiVersion,
    reachable: false,
    error: null,
  }
  if (!out.configured) {
    out.error = 'WHATSAPP_PHONE_NUMBER_ID ou WHATSAPP_ACCESS_TOKEN ausentes no .env'
    res.status(200).json(out)
    return
  }
  try {
    const url = `https://graph.facebook.com/${apiVersion}/${encodeURIComponent(phoneId)}?fields=display_phone_number,quality_rating,verified_name,name_status`
    const r = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    })
    const text = await r.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = text }
    if (!r.ok) {
      out.error = `Meta ${r.status}: ${typeof data === 'string' ? data.slice(0, 400) : JSON.stringify(data?.error || data || {}).slice(0, 400)}`
      out.metaResponse = data?.error || data || null
      res.status(200).json(out)
      return
    }
    out.reachable = true
    out.displayPhoneNumber = data?.display_phone_number || null
    out.qualityRating = data?.quality_rating || null
    out.verifiedName = data?.verified_name || null
    out.nameStatus = data?.name_status || null
    res.status(200).json(out)
  } catch (e) {
    out.error = e.message
    res.status(200).json(out)
  }
})

app.get('/api/evolution/health', async (_req, res) => {
  try {
    const ping = await pingBackend(process.env)
    res.json({
      ok: true,
      buffer: ping,
      webhookDiagnostics: getWebhookDiagnosticsSnapshot(),
      webhookForwarder: getForwarderSnapshot(process.env),
      kommoPoll: getKommoPollSnapshot(),
      kommoDispatcher: {
        url: process.env.KOMMO_DISPATCHER_URL || 'http://banco-kommo-dispatcher:8000',
        configured: Boolean(process.env.KOMMO_DISPATCHER_URL),
        probeEndpoint: '/api/kommo-dispatcher/probe?path=/api/kommo/dashboard/stats',
      },
      models: getModelRegistrySnapshot(process.env),
      queryRewriteEnabled:
        String(process.env.AI_QUERY_REWRITE_ENABLED ?? 'true').toLowerCase() !== 'false',
      debounceMs: getDebounceMs(process.env),
      scheduler: {
        running: isSchedulerRunning(),
        intervalSec: Number(process.env.KOMMO_SCHEDULER_INTERVAL_SEC) || 30,
        debounceSec: Number(process.env.KOMMO_SCHEDULER_DEBOUNCE_SEC) || 15,
        pipelineId: process.env.KOMMO_AGENT_PIPELINE_ID || null,
        statusId: process.env.KOMMO_AGENT_STATUS_ID || null,
      },
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Inspeção do poll Kommo: lista notas brutas (note_type, params.text) para um lead.
app.get('/api/kommo/poll/notes', async (req, res) => {
  try {
    const leadId = Number(req.query.leadId)
    if (!Number.isFinite(leadId) || leadId <= 0) {
      res.status(400).json({ ok: false, error: 'leadId é obrigatório (?leadId=...)' })
      return
    }
    const limit = Math.min(80, Math.max(1, Number(req.query.limit) || 30))
    const out = await listLeadNotes(process.env, leadId, { limit, order: 'desc' })
    if (!out.ok) {
      res.status(500).json({ ok: false, error: out.error || out.status })
      return
    }
    const slim = (out.notes || []).map((n) => ({
      id: n.id,
      created_at: n.created_at,
      updated_at: n.updated_at,
      note_type: n.note_type,
      params: n.params,
    }))
    res.json({ ok: true, leadId, total: slim.length, notes: slim })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Resumo do OpenAPI do banco-kommo-dispatcher ──
//
// Lista todas as rotas + métodos + summary do FastAPI do dispatcher num formato
// legível. Use isto antes de probe — descobre o nome correto da rota de mensagens.
//
//   GET /api/kommo-dispatcher/openapi-summary
//   GET /api/kommo-dispatcher/openapi-summary?filter=msg
app.get('/api/kommo-dispatcher/openapi-summary', async (req, res) => {
  const upstream = String(
    process.env.KOMMO_DISPATCHER_URL || 'http://banco-kommo-dispatcher:8000',
  ).replace(/\/$/, '')
  const filter = String(req.query.filter || '').trim().toLowerCase()
  const url = `${upstream}/openapi.json`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) {
      res.status(502).json({
        ok: false,
        upstream,
        url,
        httpStatus: r.status,
        error: 'openapi.json não retornou 200',
      })
      return
    }
    const spec = await r.json()
    const info = spec?.info || {}
    const paths = spec?.paths || {}
    const routes = []
    for (const [p, methods] of Object.entries(paths)) {
      if (!methods || typeof methods !== 'object') continue
      for (const [method, def] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'patch', 'delete'].includes(method.toLowerCase())) continue
        const m = String(method).toUpperCase()
        const summary = def?.summary || def?.operationId || ''
        const params = Array.isArray(def?.parameters)
          ? def.parameters
              .map((x) => `${x?.name}${x?.required ? '*' : ''}:${x?.in || '?'}`)
              .join(',')
          : ''
        routes.push({ method: m, path: p, summary, params })
      }
    }
    routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
    const filtered = filter
      ? routes.filter(
          (r) =>
            r.path.toLowerCase().includes(filter) ||
            (r.summary || '').toLowerCase().includes(filter),
        )
      : routes
    res.json({
      ok: true,
      upstream,
      title: info.title || null,
      version: info.version || null,
      filterApplied: filter || null,
      totalRoutes: routes.length,
      shown: filtered.length,
      routes: filtered,
    })
  } catch (e) {
    res.status(502).json({
      ok: false,
      upstream,
      url,
      error: e.message,
      cause: e?.cause?.code || e?.code || null,
    })
  } finally {
    clearTimeout(timer)
  }
})

// ── Proxy de sondagem para o banco-kommo-dispatcher (rede interna do EasyPanel) ──
//
// Usado para descobrir QUAIS endpoints o dispatcher expõe além do
// /api/kommo/dashboard/stats que já conhecemos.
//
//   GET /api/kommo-dispatcher/probe?path=/api/kommo/dashboard/stats
//   GET /api/kommo-dispatcher/probe?path=/api/kommo/messages/by-lead/19884275&limit=10&order=desc
//   GET /api/kommo-dispatcher/probe?path=/api/kommo/messages/sync/19884275&method=POST
//
// Toda query param diferente de `path` e `method` é encaminhada para a rota
// upstream. `method` (default GET) permite testar POST/PUT/DELETE.
//
// Defaults: KOMMO_DISPATCHER_URL=http://banco-kommo-dispatcher:8000
app.get('/api/kommo-dispatcher/probe', async (req, res) => {
  const upstream = String(
    process.env.KOMMO_DISPATCHER_URL || 'http://banco-kommo-dispatcher:8000',
  ).replace(/\/$/, '')
  const rawPath = String(req.query.path || '').trim()
  if (!rawPath || !rawPath.startsWith('/')) {
    res.status(400).json({
      ok: false,
      error: 'path obrigatório (?path=/api/kommo/dashboard/stats)',
      upstream,
    })
    return
  }
  // Encaminha automaticamente todas as outras query params para a rota upstream.
  // Ex.: /probe?path=/api/kommo/messages/by-lead/123&limit=10&order=desc  →
  //       http://dispatcher/api/kommo/messages/by-lead/123?limit=10&order=desc
  const extraEntries = Object.entries(req.query).filter(([k]) => k !== 'path' && k !== 'method')
  let pathWithQuery = rawPath
  if (extraEntries.length > 0) {
    const sep = rawPath.includes('?') ? '&' : '?'
    const qs = extraEntries
      .flatMap(([k, v]) =>
        Array.isArray(v)
          ? v.map((vv) => `${encodeURIComponent(k)}=${encodeURIComponent(String(vv))}`)
          : [`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`],
      )
      .join('&')
    pathWithQuery = `${rawPath}${sep}${qs}`
  }
  const method = String(req.query.method || 'GET').toUpperCase()
  const url = `${upstream}${pathWithQuery}`
  const startMs = Date.now()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, { method, signal: ctrl.signal })
    const elapsedMs = Date.now() - startMs
    const ct = r.headers.get('content-type') || ''
    const raw = await r.text()
    let parsed = null
    if (ct.includes('json')) {
      try { parsed = JSON.parse(raw) } catch { parsed = null }
    }
    const summary = parsed && typeof parsed === 'object'
      ? Object.fromEntries(
          Object.entries(parsed).map(([k, v]) => {
            if (Array.isArray(v)) return [k, `array[${v.length}]`]
            if (v && typeof v === 'object') return [k, `object{${Object.keys(v).slice(0, 8).join(',')}}`]
            return [k, typeof v]
          }),
        )
      : null
    res.json({
      ok: r.ok,
      httpStatus: r.status,
      elapsedMs,
      upstream,
      url,
      contentType: ct,
      shape: summary,
      json: parsed,
      textPreview: parsed ? null : raw.slice(0, 1500),
    })
  } catch (e) {
    const cause = e?.cause?.code || e?.code || ''
    let hint
    if (cause === 'ENOTFOUND') {
      hint = `DNS falhou para ${upstream}. Confirme o nome do servico no EasyPanel ou seta KOMMO_DISPATCHER_URL com a URL correta.`
    } else if (cause === 'ECONNREFUSED') {
      hint = `${upstream} recusou conexao — servico desligado ou em outra porta.`
    } else if (e.name === 'AbortError') {
      hint = `Timeout de 15s atingido em ${url}.`
    }
    res.status(502).json({
      ok: false,
      upstream,
      url,
      error: e.message,
      cause,
      hint,
    })
  } finally {
    clearTimeout(timer)
  }
})

// Inspeção do poll Kommo (events): lista eventos brutos do log para um lead/contato.
// No browser use a URL completa do backend, ex.:
//   http://localhost:8000/api/kommo/poll/events?leadId=19884275&hours=48&types=*
// Em produção troque pelo host público (Easypanel / domínio) + mesma path e query.
//
//   GET /api/kommo/poll/events?leadId=19884275&hours=72&types=incoming_chat_message,outgoing_chat_message
//   GET /api/kommo/poll/events?leadId=19884275&hours=72&types=*        (* = sem filtro de tipo, lista TUDO)
//   GET /api/kommo/poll/events?entity=contact&entityId=12345&hours=72  (eventos no contato em vez do lead)
app.get('/api/kommo/poll/events', async (req, res) => {
  try {
    const entity = String(req.query.entity || 'lead').toLowerCase() === 'contact' ? 'contact' : 'lead'
    const entityId = Number(req.query.entityId || req.query.leadId)
    if (!Number.isFinite(entityId) || entityId <= 0) {
      res.status(400).json({ ok: false, error: 'leadId/entityId é obrigatório (?leadId=... ou ?entity=contact&entityId=...)' })
      return
    }
    const limit = Math.min(250, Math.max(1, Number(req.query.limit) || 50))
    const hours = Math.max(0, Number(req.query.hours) || 0)
    const fromTs = hours > 0 ? Math.floor(Date.now() / 1000) - hours * 3600 : 0
    const typesParam = String(req.query.types || '').trim()
    let types
    if (typesParam === '*' || typesParam.toLowerCase() === 'any' || typesParam.toLowerCase() === 'all') {
      types = [] // sem filtro — lista todos os tipos para o entity
    } else if (typesParam) {
      types = typesParam.split(/[,\s]+/).filter(Boolean)
    } else {
      types = ['incoming_chat_message', 'outgoing_chat_message']
    }

    const out = await listLeadEvents(process.env, entityId, {
      types,
      fromTs,
      limit,
      entity,
      entityId,
    })
    if (!out.ok) {
      res.status(500).json({
        ok: false,
        error: out.error || out.status,
        status: out.status || null,
        requestUrl: out.requestUrl || null,
      })
      return
    }
    const slim = (out.events || []).map((e) => ({
      id: e.id,
      type: e.type,
      entity_id: e.entity_id,
      entity_type: e.entity_type,
      created_at: e.created_at,
      created_by: e.created_by,
      value_after: e.value_after ?? null,
    }))
    const counts = slim.reduce((acc, e) => {
      const t = String(e.type || 'unknown').toLowerCase()
      acc[t] = (acc[t] || 0) + 1
      return acc
    }, {})
    res.json({
      ok: true,
      entity,
      entityId,
      filter: { types, fromTs, hours },
      total: slim.length,
      typeCounts: counts,
      requestUrl: out.requestUrl || null,
      events: slim,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ─────────────── Salesbot — Pesquisa de Curso ───────────────
//
// Webhook do Kommo (amocrm) → roda o fluxo "robocsv" que busca o
// curso na base, normaliza e atualiza o lead.
//
// Aceita o path em duas variantes pra facilitar configuração:
//   - POST /api/salesbot/webhook  (preferido, usa header convencional)
//   - POST /webhook/robocsv       (compat com a URL antiga do n8n —
//                                  útil se o operador não quiser mexer
//                                  na config do amocrm)
//
// Resposta sempre 200 (mesmo em erro), pra que o amocrm não tente
// reentregar e gerar duplicação. Os erros ficam visíveis em
// /Execuções Salesbot.
async function handleSalesbotWebhook(req, res) {
  const leadId = extractLeadIdFromWebhookBody(req.body)
  if (!leadId) {
    res.status(200).json({
      ok: false,
      error: 'leadId ausente no payload (esperado leads[add][0][id] ou leads[update][0][id])',
      receivedKeys: Object.keys(req.body || {}).slice(0, 12),
    })
    return
  }
  // Roda assíncrono — mas devolvemos imediato pro amocrm não esperar.
  ;(async () => {
    const exec = await runSalesbotCsv(process.env, { leadId })
    const save = await saveSalesbotExecution(process.env, exec)
    if (!save.ok) {
      console.warn(`[salesbot] saveSalesbotExecution falhou: ${save.error || save.status}`)
    }
    if (exec.error) {
      console.warn(`[salesbot] ${exec.executionId} lead=${leadId} ERRO: ${exec.error}`)
    } else {
      console.log(
        `[salesbot] ${exec.executionId} lead=${leadId} ${exec.encontrado ? 'OK' : 'NAO_ENCONTRADO'} curso="${exec.cursoCorrigido || exec.cursoOriginal}" (${exec.durationMs}ms)`,
      )
    }
  })().catch((e) => {
    console.error('[salesbot] exception não tratada:', e.message)
  })

  res.status(200).json({ ok: true, accepted: true, leadId })
}

app.post('/api/salesbot/webhook', handleSalesbotWebhook)
// Compat com URL antiga do n8n (POST /webhook/robocsv).
app.post('/webhook/robocsv', handleSalesbotWebhook)

// Endpoint manual pra forçar uma execução do salesbot pra testar
// um lead específico, sem precisar disparar via amocrm:
//   POST /api/salesbot/run  body: { leadId: 12345 }
// Resposta vem síncrona com o resultado completo.
app.post('/api/salesbot/run', async (req, res) => {
  try {
    const leadId = Number(req.body?.leadId)
    if (!Number.isFinite(leadId) || leadId <= 0) {
      res.status(400).json({ ok: false, error: 'body.leadId é obrigatório' })
      return
    }
    const exec = await runSalesbotCsv(process.env, { leadId })
    await saveSalesbotExecution(process.env, exec).catch(() => {})
    res.json(exec)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Reindex one-shot da tabela vetorial cursos_salesbot_pos_nome.
// Sem UI — dispara via curl depois de inserir os cursos via SQL:
//   curl -X POST https://<host>/api/salesbot/reindex-pos
// Default: clear=true (apaga embeddings antigos pra evitar duplicata).
app.post('/api/salesbot/reindex-pos', async (req, res) => {
  try {
    const clear = req.body?.clear === false ? false : true
    const result = await reindexPos(process.env, { clear })
    res.status(result.ok ? 200 : 500).json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Reindex do FAQ — gera embedding pra cada linha em documents_perguntas.
// Default: só linhas com embedding NULL (perfeito depois de inserir
// uma pergunta nova via SQL). Com { force: true } regenera tudo.
//   curl -X POST https://<host>/api/ai/reindex-perguntas
//   curl -X POST https://<host>/api/ai/reindex-perguntas -H 'Content-Type: application/json' -d '{"force":true}'
app.post('/api/ai/reindex-perguntas', async (req, res) => {
  try {
    const force = req.body?.force === true || req.body?.clear === true
    const result = await reindexPerguntas(process.env, { force })
    res.status(result.ok ? 200 : 500).json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Probe da busca vetorial em cursos_salesbot_pos_nome — sem efeito
// colateral (não chama agente IA, não PATCHa Kommo). Útil pra
// validar visualmente se um termo acha o curso certo.
//   GET /api/salesbot/probe-pos?q=gestao publica&n=5
app.get('/api/salesbot/probe-pos', async (req, res) => {
  try {
    const query = String(req.query?.q || req.query?.query || '').trim()
    const topN = Number(req.query?.n || req.query?.topN || 3)
    const result = await probePos(process.env, { query, topN })
    res.status(200).json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Debug: lista alguns rows brutos de documents_precos pra inspecionar
// o formato real do `metadata`. Útil quando o extractor canônico
// (extractPriceMeta) está retornando null e a IA segue alucinando.
// Ex.: GET /api/debug/documents-precos?like=Gestão Ambiental&limit=5
app.get('/api/debug/documents-precos', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_KEY não configurado' })
    return
  }
  try {
    const like = String(req.query?.like || '').trim()
    const limit = Math.min(20, Math.max(1, Number(req.query?.limit) || 10))
    const filters = ['select=id,content,metadata', `limit=${limit}`, 'order=id.asc']
    if (like) filters.push(`content=ilike.%${encodeURIComponent(like)}%`)
    const url = `${SUPABASE_URL}/rest/v1/documents_precos?${filters.join('&')}`
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const text = await r.text()
    if (!r.ok) {
      res.status(r.status).type('application/json').send(text)
      return
    }
    res.type('application/json').send(text)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Lista das execuções do salesbot (proxy direto ao Supabase pra
// não precisar replicar lógica no client).
app.get('/api/salesbot/executions', async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ error: 'SUPABASE_URL/SUPABASE_KEY não configurado' })
    return
  }
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200))
    const url = `${SUPABASE_URL}/rest/v1/salesbot_execucoes?select=*&order=created_at.desc&limit=${limit}`
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    })
    const text = await r.text()
    if (!r.ok) {
      res.status(r.status).type('application/json').send(text)
      return
    }
    res.type('application/json').send(text)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Lista TODOS os custom fields de leads no Kommo (id + nome + tipo).
// Útil para descobrir o field_id de campos novos sem precisar abrir
// o painel do Kommo. Resultado vem ordenado por nome.
//   GET /api/kommo/lead-fields           → JSON com todos
//   GET /api/kommo/lead-fields?q=curso   → filtra pelo nome (substring)
//   GET /api/kommo/lead-fields?force=1   → ignora cache (TTL 5min)
app.get('/api/kommo/lead-fields', async (req, res) => {
  try {
    const force = String(req.query.force || '').toLowerCase() === '1' || String(req.query.force || '').toLowerCase() === 'true'
    const q = String(req.query.q || '').trim().toLowerCase()
    const out = await listLeadCustomFields(process.env, { force })
    if (!out.ok) {
      res.status(502).json({ ok: false, error: out.error || `status ${out.status}` })
      return
    }
    let fields = (out.raw || []).map((f) => ({
      id: f.id,
      name: f.name,
      type: f.type,
      enums: Array.isArray(f.enums)
        ? f.enums.map((e) => ({ id: e.id, value: e.value, sort: e.sort }))
        : null,
    }))
    if (q) {
      fields = fields.filter((f) => String(f.name || '').toLowerCase().includes(q))
    }
    fields.sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'))
    res.json({ ok: true, total: fields.length, cached: out.cached, fields })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

/**
 * Lê `KOMMO_LEAD_CHAT_MAP` JSON: { "19884275": "<uuid-conversa-amojo>" }.
 */
function getLeadChatIdFromEnvMap(env, leadId) {
  const raw = String(env.KOMMO_LEAD_CHAT_MAP || '').trim()
  if (!raw) return null
  try {
    const j = JSON.parse(raw)
    const lid = String(leadId)
    const v = j[lid] ?? j[Number(leadId)]
    if (v == null) return null
    const s = String(v).trim()
    return s || null
  } catch {
    return null
  }
}

// Histórico de chat Kommo (Chats API / Amojo) para um lead — o que a doc chama de
// "Get chat history": precisa de talk → chat_id e KOMMO_CHANNEL_SECRET + scope.
// @see https://developers.kommo.com/reference/chat-history
// @see https://developers.kommo.com/reference/get-conversation (GET /api/v4/talks/{id})
//
//   GET https://<seu-host>/api/kommo/poll/chat-history?leadId=19884275&historyLimit=30
app.get('/api/kommo/poll/chat-history', async (req, res) => {
  try {
    const env = process.env
    const leadId = Number(req.query.leadId)
    if (!Number.isFinite(leadId) || leadId <= 0) {
      res.status(400).json({ ok: false, error: 'leadId é obrigatório (?leadId=...)' })
      return
    }
    const historyLimit = Math.min(50, Math.max(1, Number(req.query.historyLimit) || 30))
    const maxTalkDetails = Math.min(15, Math.max(1, Number(req.query.maxTalks) || 8))

    const talksListed = await tryListTalksForLead(env, leadId)
    const talks = talksListed.talks || []
    const contactIds = await getLeadContactIds(env, leadId)
    const contactChatsByContact = []
    for (const cid of contactIds) {
      const cc = await listContactChats(env, cid)
      contactChatsByContact.push({
        contactId: cid,
        ok: cc.ok,
        status: cc.status,
        error: cc.error || null,
        chats: cc.chats || [],
      })
    }

    const talksSlim = talks.map((t) => ({
      id: t?.id ?? t?.talk_id,
      contact_id: t?.contact_id,
      entity_id: t?.entity_id,
      entity_type: t?.entity_type,
      is_in_work: t?.is_in_work,
      origin: t?.origin,
    }))

    const talkDetails = []
    for (const t of talks.slice(0, maxTalkDetails)) {
      const rawTid = t?.id ?? t?.talk_id
      if (rawTid == null || rawTid === '') continue
      const detail = await getTalkById(env, rawTid)
      if (!detail.ok) {
        talkDetails.push({ talkId: rawTid, ok: false, error: detail.error || detail.status })
        continue
      }
      const talk = detail.talk || {}
      talkDetails.push({
        talkId: rawTid,
        ok: true,
        chat_id: talk.chat_id != null ? String(talk.chat_id) : null,
        contact_id: talk.contact_id,
        entity_id: talk.entity_id,
        entity_type: talk.entity_type,
        origin: talk.origin,
      })
    }

    const scopeId = String(env.KOMMO_CHANNEL_SCOPE_ID || '').trim()
    const secretOk = Boolean(String(env.KOMMO_CHANNEL_SECRET || '').trim())
    const chatIds = new Set()
    const fromMap = getLeadChatIdFromEnvMap(env, leadId)
    if (fromMap) chatIds.add(fromMap)
    for (const block of contactChatsByContact) {
      for (const ch of block.chats || []) {
        if (ch.chat_id) chatIds.add(String(ch.chat_id))
      }
    }
    for (const row of talkDetails) {
      if (row.ok && row.chat_id) chatIds.add(row.chat_id)
    }

    const amojoChats = []
    if (!secretOk || !scopeId) {
      amojoChats.push({
        conversationId: null,
        skipped: true,
        reason: 'Defina KOMMO_CHANNEL_SECRET e KOMMO_CHANNEL_SCOPE_ID para chamar o histórico Amojo (doc: Get chat history).',
      })
    } else {
      for (const conversationId of chatIds) {
        const hist = await fetchAmojoChatHistory(env, {
          scopeId,
          conversationId,
          limit: historyLimit,
          offset: 0,
        })
        if (!hist.ok) {
          amojoChats.push({
            conversationId,
            ok: false,
            error: hist.error || String(hist.status || 'erro'),
            status: hist.status || null,
          })
          continue
        }
        const rows = hist.messages || []
        const sample = rows.slice(-15).map((row) => {
          const inner = row?.message || {}
          const text = String(inner.text ?? inner.body ?? inner.content ?? '').trim()
          return {
            message_id: inner.id != null ? String(inner.id) : row?.id != null ? String(row.id) : null,
            type: inner.type || null,
            text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
            msec_timestamp: row.msec_timestamp ?? null,
            sender_phone: row?.sender?.phone ?? null,
          }
        })
        amojoChats.push({
          conversationId,
          ok: true,
          messageCount: rows.length,
          sample,
        })
      }
    }

    res.json({
      ok: true,
      leadId,
      kommoDocs: {
        chatHistory: 'https://developers.kommo.com/reference/chat-history',
        talkById: 'https://developers.kommo.com/reference/get-conversation',
        contactChats: 'https://developers.kommo.com/reference/get-contact-chats',
      },
      contactIds,
      contactChatsByContact,
      talks: {
        listOk: talksListed.ok !== false,
        listError: talksListed.error || null,
        count: talks.length,
        items: talksSlim,
      },
      talksDetail: talkDetails,
      leadChatMapEntry: fromMap || null,
      amojo: {
        secretConfigured: secretOk,
        scopeIdConfigured: Boolean(scopeId),
        scopeIdPreview: scopeId ? `${scopeId.slice(0, 8)}…` : null,
        chatIdsTried: [...chatIds],
        results: amojoChats,
      },
      hint:
        'Texto WhatsApp: GET /api/v4/contacts/chats?contact_id= (ver contactChatsByContact) ou talks+chat_id; corpo das mensagens: Chats API history (Amojo) com KOMMO_CHANNEL_SECRET+SCOPE ou dispatcher /api/kommo/poll/dispatcher.',
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Inspeção do poll Kommo (dispatcher): lista mensagens cruas que o
// banco-kommo-dispatcher tem cacheadas para um lead. Útil para validar a
// integração antes de ligar mode=dispatcher no scheduler.
//   GET /api/kommo/poll/dispatcher?leadId=19884275&limit=20&order=desc
app.get('/api/kommo/poll/dispatcher', async (req, res) => {
  try {
    const leadId = Number(req.query.leadId)
    if (!Number.isFinite(leadId) || leadId <= 0) {
      res.status(400).json({ ok: false, error: 'leadId é obrigatório (?leadId=...)' })
      return
    }
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20))
    const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'
    const out = await dispatcherGetMessagesByLead(process.env, leadId, { limit, order })
    if (!out.ok) {
      res.status(502).json({
        ok: false,
        error: out.error || out.status,
        cause: out.cause || null,
        status: out.status || null,
        requestUrl: out.requestUrl || null,
        elapsedMs: out.elapsedMs || null,
        hint:
          'Verifique KOMMO_DISPATCHER_URL e se o servico banco-kommo-dispatcher esta respondendo (use /api/kommo-dispatcher/probe?path=/health).',
      })
      return
    }
    const messages = out.messages || []
    const stats = messages.reduce(
      (acc, m) => {
        const st = String(m?.sender_type || 'unknown').toLowerCase()
        const mt = String(m?.message_type || 'unknown').toLowerCase()
        acc.senderTypes[st] = (acc.senderTypes[st] || 0) + 1
        acc.messageTypes[mt] = (acc.messageTypes[mt] || 0) + 1
        return acc
      },
      { senderTypes: {}, messageTypes: {} },
    )
    const slim = messages.map((m) => ({
      id: m.id,
      sender_type: m.sender_type,
      sender_name: m.sender_name,
      message_type: m.message_type,
      message_text: m.message_text,
      media_url: m.media_url || null,
      sent_at: m.sent_at,
      origin: m.origin,
      synced_at: m.synced_at,
      chat_id: m.chat_id,
    }))
    res.json({
      ok: true,
      leadId,
      total: messages.length,
      stats,
      requestUrl: out.requestUrl || null,
      elapsedMs: out.elapsedMs || null,
      messages: slim,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// Testa o "digitando..." (Evolution presence) num número específico.
// Útil para validar que a instância Evolution está online e aceitando
// presence. Não exige webhook — chama POST /chat/sendPresence direto.
//
//   GET  /api/evolution/typing-test?to=5511945722117&presence=composing&delayMs=8000
//   POST /api/evolution/typing-test   body { to, presence?, delayMs? }
async function handleTypingTest(req, res) {
  try {
    const src = req.method === 'POST' ? { ...(req.body || {}), ...req.query } : req.query
    const to = String(src.to || '').trim()
    if (!to) {
      res.status(400).json({ ok: false, error: 'to é obrigatório (?to=5511XXXXXXXXX ou JID)' })
      return
    }
    const presence = String(src.presence || 'composing').toLowerCase()
    const delayMs = Number(src.delayMs)
    const r = await sendTyping(process.env, {
      jid: to,
      presence,
      delayMs: Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : undefined,
    })
    if (!r.ok) {
      const hintByCode = {
        EVOLUTION_NOT_CONFIGURED: 'Defina EVOLUTION_API_URL, EVOLUTION_API_KEY e EVOLUTION_INSTANCE no .env.',
        EVOLUTION_TIMEOUT: 'A Evolution não respondeu em 8s. Verifique se EVOLUTION_API_URL está acessível do container do agente (testa com /api/evolution/typing-test ou ping interno).',
        EVOLUTION_FETCH_FAILED: 'Falha de rede chamando a Evolution. Cheque se EVOLUTION_API_URL está correta (sem barra final, com https://) e se o serviço Evolution está rodando.',
        EVOLUTION_PRESENCE_FAILED: 'A Evolution recebeu mas rejeitou o request. 401=apikey errada, 404=instance errada, 400=number/payload errado.',
      }
      res.status(r.code === 'EVOLUTION_NOT_CONFIGURED' ? 503 : 502).json({
        ok: false,
        code: r.code,
        status: r.status || null,
        error: r.error,
        cause: r.cause || null,
        requestUrl: r.requestUrl || null,
        elapsedMs: r.elapsedMs ?? null,
        hint: hintByCode[r.code] || null,
      })
      return
    }
    res.json({
      ok: true,
      status: r.status,
      data: r.data,
      presence,
      to,
      delayMs: delayMs || null,
      requestUrl: r.requestUrl || null,
      elapsedMs: r.elapsedMs ?? null,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}
app.get('/api/evolution/typing-test', handleTypingTest)
app.post('/api/evolution/typing-test', handleTypingTest)

// ── /api/evolution/media-test ──
//
// Baixa o base64 de uma mensagem de mídia (áudio/imagem/documento) via
// `/chat/getBase64FromMediaMessage/{instance}` da Evolution. Útil pra
// validar credenciais e ver se a Evolution está mesmo retornando o
// conteúdo, sem precisar enviar áudio real.
//
// Uso:
//   POST /api/evolution/media-test
//   body:
//     { "messageId": "<wamid>", "remoteJid": "5511...@s.whatsapp.net",
//       "fromMe": false, "instance": "<opcional>" }
//
// Resposta (sucesso): { ok: true, base64Length, mimetype, fileName, transcribed?, vision? }
// Pra economizar payload, devolve só o tamanho do base64 (não o conteúdo).
// Se passar `?transcribe=1` na query, roda Whisper e devolve o texto.
async function handleMediaTest(req, res) {
  try {
    const body = req.method === 'GET' ? req.query : req.body || {}
    const messageId = String(body.messageId || '').trim()
    const remoteJid = String(body.remoteJid || '').trim()
    const fromMe = body.fromMe === 'true' || body.fromMe === true
    const instance = String(body.instance || '').trim() || undefined
    if (!messageId || !remoteJid) {
      res.status(400).json({
        ok: false,
        error: 'messageId e remoteJid são obrigatórios. Pegue eles em /api/kommo/poll/dispatcher ou nos logs do webhook.',
      })
      return
    }
    const fakePayload = {
      data: {
        key: { id: messageId, remoteJid, fromMe },
      },
    }
    const dl = await fetchEvolutionMediaBase64(process.env, { instance, payload: fakePayload })
    if (!dl.ok) {
      res.status(502).json({
        ok: false,
        code: dl.code,
        status: dl.status || null,
        error: dl.error,
        elapsedMs: dl.elapsedMs || null,
        retried: Boolean(dl.retried),
        hint:
          dl.code === 'EVOLUTION_NOT_CONFIGURED'
            ? 'Configure EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE no env do container.'
            : dl.code === 'EVOLUTION_TIMEOUT'
              ? 'A Evolution demorou >15s. Veja se EVOLUTION_API_URL está acessível e se a instância existe.'
              : 'Ver logs da Evolution. Verifique se messageId/remoteJid existem no histórico da instância.',
      })
      return
    }
    const result = {
      ok: true,
      base64Length: dl.base64?.length || 0,
      mimetype: dl.mimetype,
      fileName: dl.fileName,
      elapsedMs: dl.elapsedMs,
      retried: Boolean(dl.retried),
    }
    if (String(req.query.transcribe || '').toLowerCase() === '1') {
      try {
        const txt = await transcribeAudioBase64(process.env, dl.base64, {
          filename: dl.fileName || 'file.ogg',
          mimeType: dl.mimetype || 'audio/ogg',
        })
        result.transcribed = txt
      } catch (e) {
        result.transcribed = null
        result.transcribeError = e.message
      }
    }
    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}
app.get('/api/evolution/media-test', handleMediaTest)
app.post('/api/evolution/media-test', handleMediaTest)

// ── /api/media/url-test ──
//
// Baixa uma URL arbitrária (ex.: media_url devolvido pelo dispatcher
// pra mensagens de voz/imagem) e devolve metadados + base64Length.
// Com ?transcribe=1 também roda Whisper em cima do áudio. Útil pra
// diagnosticar se a URL tá pública / se precisa de auth / se whisper
// engole o formato.
//
//   GET /api/media/url-test?url=<URL>&transcribe=1
async function handleUrlMediaTest(req, res) {
  try {
    const url = String(
      req.query.url || (req.body && req.body.url) || '',
    ).trim()
    if (!url) {
      res.status(400).json({ ok: false, error: 'url é obrigatório (?url=...)' })
      return
    }
    const dl = await downloadUrlAsBase64(process.env, url)
    if (!dl.ok) {
      res.status(502).json({
        ok: false,
        url,
        code: dl.code,
        status: dl.status || null,
        error: dl.error,
        attempts: dl.attempts || [],
        elapsedMs: dl.elapsedMs || null,
      })
      return
    }
    const result = {
      ok: true,
      url,
      base64Length: dl.base64?.length || 0,
      bytes: dl.bytes,
      mimeType: dl.mimeType,
      attempts: dl.attempts,
      elapsedMs: dl.elapsedMs,
    }
    if (String(req.query.transcribe || '').toLowerCase() === '1') {
      try {
        const txt = await transcribeAudioBase64(process.env, dl.base64, {
          filename: 'voice.ogg',
          mimeType: dl.mimeType || 'audio/ogg',
        })
        result.transcribed = txt
      } catch (e) {
        result.transcribed = null
        result.transcribeError = e.message
      }
    }
    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
}
app.get('/api/media/url-test', handleUrlMediaTest)
app.post('/api/media/url-test', handleUrlMediaTest)

// ── /api/agent/diagnose ──
//
// Diagnóstico ponta-a-ponta de UM lead específico. Foi feito pra
// resolver "mandei áudio, IA não respondeu, e agora?".
// Devolve, em uma única chamada:
//   1) Config do scheduler (pipeline/status alvo, intervalo, está rodando?).
//   2) Últimas N mensagens do `banco-kommo-dispatcher` pro lead, com
//      message_type, media_url e sent_at — mostra se o áudio chegou
//      no cache da fonte.
//   3) Pra cada mensagem `voice`/`audio`/`picture` recente, faz um
//      teste de download da media_url (sem rodar Whisper/Vision, só
//      pra validar se a URL é acessível e quanto pesa).
//   4) Snapshot do buffer atual da sessão WhatsApp construída a
//      partir do telefone informado (se for, mostra quantas mensagens
//      estão pendentes esperando o flush do scheduler).
//
//   GET /api/agent/diagnose?leadId=19884275&phone=5511999999999&limit=10
//
// `phone` é opcional — se passar, a gente também mostra o buffer
// pra essa sessão.
app.get('/api/agent/diagnose', async (req, res) => {
  const leadId = Number(req.query.leadId)
  if (!Number.isFinite(leadId) || leadId <= 0) {
    res.status(400).json({
      ok: false,
      error: 'leadId é obrigatório. Ex.: /api/agent/diagnose?leadId=19884275&phone=5511...',
      hint: 'Pegue o ID na URL do lead no Kommo: https://<conta>.kommo.com/leads/detail/<ID>',
    })
    return
  }
  const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 10))
  const phone = String(req.query.phone || '').replace(/[^0-9]/g, '')

  const env = process.env
  const out = {
    ok: true,
    leadId,
    phone: phone || null,
    timestamp: new Date().toISOString(),
    scheduler: {
      running: isSchedulerRunning(),
      intervalSec: Number(env.KOMMO_SCHEDULER_INTERVAL_SEC) || 10,
      debounceSec: Number(env.KOMMO_SCHEDULER_DEBOUNCE_SEC) || 5,
      pipelineId: env.KOMMO_AGENT_PIPELINE_ID || null,
      statusId: env.KOMMO_AGENT_STATUS_ID || null,
      enabledFlag: env.KOMMO_SCHEDULER_ENABLED ?? null,
      testWhitelist: env.KOMMO_AGENT_TEST_LEAD_IDS || null,
      inboundPollEnabled: String(env.KOMMO_INBOUND_POLL_ENABLED || 'false').toLowerCase() === 'true',
      inboundPollMode: normalizeKommoInboundPollMode(env.KOMMO_INBOUND_POLL_MODE),
      warmupFreshSec: env.KOMMO_INBOUND_WARMUP_FRESH_SEC || '120 (default)',
    },
    secrets: {
      kommoConfigured: Boolean(env.KOMMO_BASE_URL && env.KOMMO_ACCESS_TOKEN),
      dispatcherUrl: env.KOMMO_DISPATCHER_URL || 'http://banco-kommo-dispatcher:8000',
      whatsappTokenSet: Boolean(env.WHATSAPP_ACCESS_TOKEN),
      openaiKeySet: Boolean(env.OPENAI_API_KEY),
      evolutionConfigured: Boolean(
        env.EVOLUTION_API_URL && env.EVOLUTION_API_KEY && (env.EVOLUTION_INSTANCE || env.EVOLUTION_INSTANCE_NAME),
      ),
    },
    dispatcher: {
      ok: false,
      messagesTotal: 0,
      messages: [],
      mediaTests: [],
      hint: null,
    },
    buffer: null,
    nextSteps: [],
  }

  // 1) Dispatcher: ver o que tem cacheado pro lead.
  try {
    const r = await dispatcherGetMessagesByLead(env, leadId, { limit, order: 'desc' })
    if (!r.ok) {
      out.dispatcher.ok = false
      out.dispatcher.error = r.error
      out.dispatcher.status = r.status || null
      out.dispatcher.elapsedMs = r.elapsedMs || null
      out.dispatcher.hint =
        'O banco-kommo-dispatcher não respondeu. Verifique se KOMMO_DISPATCHER_URL aponta pro serviço certo dentro do EasyPanel.'
    } else {
      out.dispatcher.ok = true
      out.dispatcher.messagesTotal = (r.messages || []).length
      out.dispatcher.elapsedMs = r.elapsedMs || null
      const slim = (r.messages || []).map((m) => ({
        id: m.id,
        sender_type: m.sender_type,
        sender_name: m.sender_name,
        message_type: m.message_type,
        message_text: (m.message_text || '').slice(0, 120),
        media_url: m.media_url || null,
        sent_at: m.sent_at,
        origin: m.origin,
      }))
      out.dispatcher.messages = slim

      // 2) Teste de download em mídias recentes (até 3 pra não estourar tempo).
      const mediaMessages = slim
        .filter((m) => {
          const t = String(m.message_type || '').toLowerCase()
          return ['voice', 'audio', 'picture', 'image'].includes(t) && m.media_url
        })
        .slice(0, 3)
      for (const m of mediaMessages) {
        const dl = await downloadUrlAsBase64(env, m.media_url)
        out.dispatcher.mediaTests.push({
          msgId: m.id,
          type: m.message_type,
          url: m.media_url,
          ok: dl.ok,
          status: dl.status || null,
          code: dl.code || null,
          bytes: dl.bytes || null,
          mimeType: dl.mimeType || null,
          attempts: dl.attempts || [],
          error: dl.ok ? null : dl.error,
          elapsedMs: dl.elapsedMs || null,
        })
      }
    }
  } catch (e) {
    out.dispatcher.ok = false
    out.dispatcher.error = e.message
  }

  // 3) Buffer atual da sessão (precisa do phone pra resolver session).
  if (phone) {
    try {
      const { phoneToWhatsAppSessionId } = await import('./server/phoneWhatsApp.js')
      const sessionId = phoneToWhatsAppSessionId(phone)
      if (sessionId) {
        const msgs = await getMessages(env, sessionId)
        out.buffer = {
          sessionId,
          pendingCount: msgs.length,
          messages: msgs.slice(0, 20).map((s) => (typeof s === 'string' ? s.slice(0, 200) : s)),
        }
      } else {
        out.buffer = { error: 'phone não resolveu sessionId válido' }
      }
    } catch (e) {
      out.buffer = { error: e.message }
    }
  }

  // 4) Gerar `nextSteps` com base nos achados — fala em humano o que checar.
  if (!out.scheduler.pipelineId || !out.scheduler.statusId) {
    out.nextSteps.push(
      'CRITICO: KOMMO_AGENT_PIPELINE_ID e KOMMO_AGENT_STATUS_ID não estão setados — scheduler nunca vai responder ninguém. Defina no env do EasyPanel e reinicie.',
    )
  }
  if (!out.scheduler.running) {
    out.nextSteps.push(
      'Scheduler NÃO está rodando neste processo. Verifique o KOMMO_SCHEDULER_ENABLED e se KOMMO_BASE_URL/KOMMO_ACCESS_TOKEN estão setados.',
    )
  }
  if (!out.scheduler.inboundPollEnabled) {
    out.nextSteps.push(
      'KOMMO_INBOUND_POLL_ENABLED não está true. Sem isso o scheduler NÃO consulta o dispatcher e mensagens que não passam pela Evolution não chegam no buffer. Set true e redeploy.',
    )
  }
  if (out.scheduler.inboundPollMode !== 'dispatcher' && out.scheduler.inboundPollMode !== 'all') {
    out.nextSteps.push(
      `KOMMO_INBOUND_POLL_MODE atual: "${out.scheduler.inboundPollMode}". Pra o cenário Kommo+áudio recomendamos "dispatcher".`,
    )
  }
  if (!out.secrets.openaiKeySet) {
    out.nextSteps.push('OPENAI_API_KEY não setada — Whisper não vai rodar.')
  }
  if (out.dispatcher.ok && out.dispatcher.messagesTotal === 0) {
    out.nextSteps.push(
      'Dispatcher devolveu 0 mensagens pro lead. Ou o lead ID está errado, ou o banco-kommo-dispatcher ainda não sincronizou. Tente /api/kommo-dispatcher/probe?path=/health.',
    )
  }
  const failedMedia = out.dispatcher.mediaTests.filter((m) => !m.ok)
  if (failedMedia.length > 0) {
    out.nextSteps.push(
      `Falhou em baixar ${failedMedia.length} mídia(s). Veja o campo .dispatcher.mediaTests — provavelmente a URL precisa de auth diferente ou o token (WHATSAPP_ACCESS_TOKEN / KOMMO_ACCESS_TOKEN) está faltando.`,
    )
  }
  if (out.nextSteps.length === 0) {
    out.nextSteps.push(
      'Tudo parece OK por aqui. Olhe os logs do EasyPanel filtrando por "[kommo-poll][dispatcher]" pra ver se a transcrição aparece. Se nada aparecer, é sinal de que o scheduler não está pegando este lead — confira se ele está realmente no pipeline+status configurados.',
    )
  }

  res.json(out)
})

// Dispara um tick do scheduler imediatamente (útil para teste).
app.post('/api/scheduler/tick', async (_req, res) => {
  try {
    const stats = await runSchedulerTick(process.env)
    res.json({ ok: true, stats })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Endpoint direto de teste do agente (mesmo loop do webhook, sem buffer) ──

app.post('/api/agent/run', async (req, res) => {
  try {
    const out = await runAgent(process.env, req.body || {})
    if (!out.ok) {
      res.status(500).json(out)
      return
    }
    res.json(out)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Playground: simular o fluxo da Evolution (buffer + debounce) ──
//    push  → empurra a mensagem no buffer (mesma tabela do webhook real)
//    flush → lê tudo, limpa o buffer e dispara o agente; retorna a reply

app.post('/api/playground/push', async (req, res) => {
  try {
    const { sessionId, message } = req.body || {}
    if (!sessionId || !message) {
      res.status(400).json({ ok: false, error: 'sessionId e message são obrigatórios' })
      return
    }
    await pushMessage(process.env, sessionId, message, { skipDedupe: true })
    res.json({ ok: true, sessionId })
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/playground/flush', async (req, res) => {
  try {
    const { sessionId, telefone, pushName } = req.body || {}
    if (!sessionId) {
      res.status(400).json({ ok: false, error: 'sessionId é obrigatório' })
      return
    }
    const result = await withSessionLock(sessionId, async () => {
      const itens = await getMessages(process.env, sessionId)
      if (!itens.length) {
        return { ok: true, empty: true, joined: '', reply: null }
      }
      await clearMessages(process.env, sessionId)
      const joined = itens.join(', ')
      const telefoneFinal = telefone || String(sessionId).split('@')[0].replace(/[^0-9]/g, '') || ''
      const executionId = generateExecutionId()
      const startedAt = new Date().toISOString()
      const out = await runAgent(process.env, {
        telefone: telefoneFinal,
        pushName: pushName || '',
        userMessage: joined,
        executionId,
      })
      if (out?.ok && out.reply) {
        getLeadIdByTelefone(process.env, telefoneFinal)
          .then((idLead) =>
            saveConversation(process.env, {
              telefone: telefoneFinal,
              userMessage: joined,
              botMessage: out.reply,
              messageType: 'conversation',
              idLead,
            }),
          )
          .then((hist) => {
            if (hist && !hist.ok) {
              const failed = hist.steps.filter((s) => s.ok === false)
              console.warn(`[${executionId}] playground history falhas:`, JSON.stringify(failed))
            }
          })
          .catch((err) => console.error(`[${executionId}] playground history exception:`, err.message))
      }
      const playgroundSteps = []
      if (out?.ctxSnapshot) {
        playgroundSteps.push({ type: 'ctx_snapshot', tool: 'agent.ctx_snapshot', result: out.ctxSnapshot })
      }
      if (Array.isArray(out?.orchestratorSteps)) {
        for (const s of out.orchestratorSteps) playgroundSteps.push(s)
      }
      saveExecution(process.env, {
        id: executionId,
        timestamp: startedAt,
        userMessage: joined,
        model: out?.model || null,
        steps: playgroundSteps,
        toolCalls: out?.toolCalls || [],
        response: out?.ok ? out.reply : null,
        error: out?.ok ? null : out?.error || null,
        totalDurationMs: out?.durationMs || 0,
        usage: out?.usage || {},
        aiMeta: out?.aiMeta || null,
        telefone: telefoneFinal,
        origem: 'playground',
      }).catch((err) => console.error(`[${executionId}] playground saveExecution exception:`, err.message))
      return { ok: true, joined, count: itens.length, ...out }
    })
    res.json(result)
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Playground: mídia (imagem e áudio) ──
//    Reusa o mesmo pipeline de média do webhook real (Whisper + GPT-4o vision).
//    Front manda base64 puro (sem prefixo data:); endpoint devolve texto.

app.post('/api/playground/transcribe', async (req, res) => {
  try {
    const { audioBase64, mimeType, filename } = req.body || {}
    if (!audioBase64) {
      res.status(400).json({ ok: false, error: 'audioBase64 é obrigatório' })
      return
    }
    const text = await transcribeAudioBase64(process.env, audioBase64, {
      filename: filename || 'audio.webm',
      mimeType: mimeType || 'audio/webm',
    })
    res.json({ ok: true, text: text || '' })
  } catch (e) {
    console.error('[playground][transcribe]', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

app.post('/api/playground/analyze-image', async (req, res) => {
  try {
    const { imageBase64, mimeType, prompt } = req.body || {}
    if (!imageBase64) {
      res.status(400).json({ ok: false, error: 'imageBase64 é obrigatório' })
      return
    }
    const text = await analyzeImageBase64(process.env, imageBase64, {
      mimeType: mimeType || 'image/jpeg',
      prompt: prompt || undefined,
    })
    res.json({ ok: true, text: text || '' })
  } catch (e) {
    console.error('[playground][analyze-image]', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Feedback IA ──────────────────────────────────────────────────────────────

function makeIaFeedbackSupabaseClient(env) {
  const url = (env.SUPABASE_URL_FEEDBACK || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY_FEEDBACK || ''
  if (!url || !key) return null

  const headers = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  }

  return {
    async select(table, query = '') {
      const res = await fetch(`${url}/rest/v1/${table}${query ? '?' + query : ''}`, { headers })
      const text = await res.text()
      if (!res.ok) throw new Error(`Supabase GET ${table} ${res.status}: ${text.slice(0, 200)}`)
      return text ? JSON.parse(text) : []
    },
  }
}

app.get('/api/ia-feedback/status', async (req, res) => {
  try {
    const runner = getIaFeedbackRunnerStatus()
    const db = makeIaFeedbackSupabaseClient(process.env)

    let lastRuns = []
    let counts = { hoje: 0, semana: 0 }
    let recentes = []

    if (db) {
      try {
        lastRuns = await db.select(
          'ia_feedback_job_runs',
          'select=*&order=started_at.desc&limit=3',
        )
      } catch { /* silencioso */ }

      try {
        const hoje = new Date()
        hoje.setHours(0, 0, 0, 0)
        const semanaAtras = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
        const [rowsHoje, rowsSemana] = await Promise.all([
          db.select('ia_feedback', `select=id&created_at=gte.${encodeURIComponent(hoje.toISOString())}`),
          db.select('ia_feedback', `select=id&created_at=gte.${encodeURIComponent(semanaAtras.toISOString())}`),
        ])
        counts.hoje = Array.isArray(rowsHoje) ? rowsHoje.length : 0
        counts.semana = Array.isArray(rowsSemana) ? rowsSemana.length : 0
      } catch { /* silencioso */ }

      try {
        recentes = await db.select(
          'ia_feedback',
          'select=id,lead_id,telefone,nota_geral,veredito,total_mensagens,total_turnos_ia,detected_at,created_at&order=created_at.desc&limit=10',
        )
      } catch { /* silencioso */ }
    }

    res.json({ runner, lastRuns, counts, recentes })
  } catch (e) {
    console.error('[ia-feedback/status]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/ia-feedback/avaliacoes', async (req, res) => {
  try {
    const db = makeIaFeedbackSupabaseClient(process.env)
    if (!db) return res.status(500).json({ error: 'SUPABASE_URL_FEEDBACK não configurado' })

    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)))
    const page = Math.max(1, Number(req.query.page || 1))
    const offset = (page - 1) * limit
    const filters = []
    if (req.query.veredito) filters.push(`veredito=eq.${encodeURIComponent(req.query.veredito)}`)
    if (req.query.lead_id) filters.push(`lead_id=eq.${encodeURIComponent(req.query.lead_id)}`)
    const filterStr = filters.length ? '&' + filters.join('&') : ''

    const rows = await db.select(
      'ia_feedback',
      `select=id,lead_id,telefone,nota_geral,veredito,resumo_avaliacao,total_mensagens,total_turnos_ia,detected_at,created_at,modelo_avaliador${filterStr}&order=created_at.desc&limit=${limit}&offset=${offset}`,
    )
    res.json({ rows: rows || [], page, limit })
  } catch (e) {
    console.error('[ia-feedback/avaliacoes]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/ia-feedback/avaliacoes/:id', async (req, res) => {
  try {
    const db = makeIaFeedbackSupabaseClient(process.env)
    if (!db) return res.status(500).json({ error: 'SUPABASE_URL_FEEDBACK não configurado' })

    const rows = await db.select(
      'ia_feedback',
      `select=*&id=eq.${encodeURIComponent(req.params.id)}&limit=1`,
    )
    const row = Array.isArray(rows) ? rows[0] : null
    if (!row) return res.status(404).json({ error: 'Não encontrado' })
    res.json(row)
  } catch (e) {
    console.error('[ia-feedback/avaliacoes/:id]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.get('/api/ia-feedback/runs', async (req, res) => {
  try {
    const db = makeIaFeedbackSupabaseClient(process.env)
    if (!db) return res.status(500).json({ error: 'SUPABASE_URL_FEEDBACK não configurado' })

    const limit = Math.min(100, Math.max(1, Number(req.query.limit || 20)))
    const rows = await db.select(
      'ia_feedback_job_runs',
      `select=*&order=started_at.desc&limit=${limit}`,
    )
    res.json(rows || [])
  } catch (e) {
    console.error('[ia-feedback/runs]', e.message)
    res.status(500).json({ error: e.message })
  }
})

app.post('/api/ia-feedback/avaliar-manual', async (req, res) => {
  try {
    const { lead_id, telefone } = req.body || {}
    if (!lead_id && !telefone) {
      return res.status(400).json({ ok: false, error: 'lead_id ou telefone é obrigatório' })
    }
    const result = await evaluateLead(process.env, {
      leadId: lead_id ? Number(lead_id) : null,
      telefone: telefone || null,
      statusIdFrom: Number(process.env.KOMMO_AGENT_STATUS_ID || 0),
      pipelineIdFrom: Number(process.env.KOMMO_AGENT_PIPELINE_ID || 0),
      detectedAt: new Date(),
      jobExecutionId: crypto.randomUUID(),
    })
    res.json(result)
  } catch (e) {
    console.error('[ia-feedback/avaliar-manual]', e.message)
    res.status(500).json({ ok: false, error: e.message })
  }
})

// ── Otimizador de Prompt ──

app.get('/api/ia-feedback/violations-ranking', async (req, res) => {
  try {
    const activeVersion = await getActiveVersion(process.env)
    if (!activeVersion) {
      return res.status(404).json({ error: 'Nenhuma versão ativa de prompt encontrada. Verifique se o seed foi executado.' })
    }
    const result = await getViolationsRanking(process.env, { activeVersion, limit: 100 })
    res.json(result)
  } catch (e) {
    console.error('[ia-feedback/violations-ranking]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.post('/api/ia-feedback/analyze-rule', async (req, res) => {
  try {
    const { regra_alvo } = req.body || {}
    if (!regra_alvo) return res.status(400).json({ error: 'regra_alvo é obrigatório (ex: "Regra 3")' })

    const activeVersion = await getActiveVersion(process.env)
    if (!activeVersion) {
      return res.status(404).json({ error: 'Nenhuma versão ativa encontrada' })
    }

    const rankingData = await getViolationsRanking(process.env, { activeVersion, limit: 100 })
    const regraNoRanking = rankingData.ranking.find((r) => r.regra === regra_alvo)
    if (!regraNoRanking) {
      return res.status(400).json({
        error: `"${regra_alvo}" não possui violações na janela atual (desde v${activeVersion.versao}). Não há base para análise.`,
      })
    }

    const proposalData = await analyzeRule(process.env, {
      regraAlvo: regra_alvo,
      ranking: rankingData,
      activeVersion,
    })

    const proposal = await createProposal(process.env, {
      baseada_em_versao_id: activeVersion.id,
      modelo_analisador: resolveModel(process.env, 'prompt_optimizer'),
      regra_alvo: proposalData.regra_alvo,
      tipo_mudanca: proposalData.tipo_mudanca,
      trecho_antes: proposalData.trecho_antes || '',
      trecho_depois: proposalData.trecho_depois || '',
      justificativa: proposalData.justificativa,
      conflitos_potenciais: proposalData.conflitos_potenciais || null,
      exemplos_violacoes: regraNoRanking.exemplos,
      total_violacoes: regraNoRanking.count,
      janela_de: rankingData.janela_de,
      janela_ate: rankingData.janela_ate,
    })

    res.json(proposal)
  } catch (e) {
    console.error('[ia-feedback/analyze-rule]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.get('/api/ia-feedback/proposals', async (req, res) => {
  try {
    const { status, limit } = req.query
    const proposals = await listProposals(process.env, {
      status: status || undefined,
      limit: limit ? Math.min(100, Math.max(1, Number(limit))) : 50,
    })
    res.json(proposals)
  } catch (e) {
    console.error('[ia-feedback/proposals]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.get('/api/ia-feedback/proposals/:id', async (req, res) => {
  try {
    const proposal = await getProposalById(process.env, req.params.id)
    if (!proposal) return res.status(404).json({ error: 'Proposta não encontrada' })
    res.json(proposal)
  } catch (e) {
    console.error('[ia-feedback/proposals/:id]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.post('/api/ia-feedback/proposals/:id/accept', async (req, res) => {
  try {
    const proposal = await getProposalById(process.env, req.params.id)
    if (!proposal) return res.status(404).json({ error: 'Proposta não encontrada' })
    if (proposal.status !== 'pendente') {
      return res.status(400).json({ error: `Proposta já está com status "${proposal.status}" — não é possível aceitar novamente` })
    }

    const activeVersion = await getActiveVersion(process.env)
    if (!activeVersion) return res.status(404).json({ error: 'Nenhuma versão ativa encontrada' })

    const activeText = activeVersion.agent_rules_text
    const novoTexto = activeText.split(proposal.trecho_antes).join(proposal.trecho_depois)

    if (novoTexto === activeText) {
      return res.status(400).json({
        error: 'trecho_antes não casa mais no prompt ativo — proposta desatualizada por uma versão posterior. Rejeite e rode análise nova.',
      })
    }

    const newVersion = await createVersionAndActivate(process.env, {
      agent_rules_text: novoTexto,
      created_by: `analyzer:${proposal.id}`,
      origem_proposta_id: proposal.id,
      diff_resumo: `${proposal.regra_alvo} (${proposal.tipo_mudanca})`,
    })

    await markProposalApplied(process.env, proposal.id, newVersion.id)
    await refreshAgentRulesText(process.env).catch(() => {})

    res.json({ ok: true, new_version: { id: newVersion.id, versao: newVersion.versao } })
  } catch (e) {
    console.error('[ia-feedback/proposals/:id/accept]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.post('/api/ia-feedback/proposals/:id/reject', async (req, res) => {
  try {
    const proposal = await getProposalById(process.env, req.params.id)
    if (!proposal) return res.status(404).json({ error: 'Proposta não encontrada' })
    await markProposalRejected(process.env, proposal.id)
    res.json({ ok: true })
  } catch (e) {
    console.error('[ia-feedback/proposals/:id/reject]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.post('/api/ia-feedback/proposals/:id/reanalyze', async (req, res) => {
  try {
    const { instrucao_extra } = req.body || {}
    if (!instrucao_extra || typeof instrucao_extra !== 'string' || !instrucao_extra.trim()) {
      return res.status(400).json({ error: 'instrucao_extra é obrigatório (texto explicando o que estava errado na proposta anterior)' })
    }

    const propostaAntiga = await getProposalById(process.env, req.params.id)
    if (!propostaAntiga) return res.status(404).json({ error: 'Proposta não encontrada' })

    const activeVersion = await getActiveVersion(process.env)
    if (!activeVersion) return res.status(404).json({ error: 'Nenhuma versão ativa encontrada' })

    const rankingData = await getViolationsRanking(process.env, { activeVersion, limit: 100 })
    const regraNoRanking = rankingData.ranking.find((r) => r.regra === propostaAntiga.regra_alvo)
    if (!regraNoRanking) {
      return res.status(400).json({
        error: `"${propostaAntiga.regra_alvo}" não tem mais violações na janela atual. Não há base para reanálise.`,
      })
    }

    const proposalData = await analyzeRule(process.env, {
      regraAlvo: propostaAntiga.regra_alvo,
      ranking: rankingData,
      activeVersion,
      instrucaoExtra: instrucao_extra.trim(),
    })

    if (propostaAntiga.status === 'pendente') {
      await markProposalRejected(process.env, propostaAntiga.id)
    }

    const novaProposta = await createProposal(process.env, {
      baseada_em_versao_id: activeVersion.id,
      modelo_analisador: resolveModel(process.env, 'prompt_optimizer'),
      regra_alvo: proposalData.regra_alvo,
      tipo_mudanca: proposalData.tipo_mudanca,
      trecho_antes: proposalData.trecho_antes || '',
      trecho_depois: proposalData.trecho_depois || '',
      justificativa: proposalData.justificativa,
      conflitos_potenciais: proposalData.conflitos_potenciais || null,
      exemplos_violacoes: regraNoRanking.exemplos,
      total_violacoes: regraNoRanking.count,
      janela_de: rankingData.janela_de,
      janela_ate: rankingData.janela_ate,
    })

    res.json({ ok: true, nova_proposta: novaProposta, proposta_antiga_rejeitada: propostaAntiga.id })
  } catch (e) {
    console.error('[ia-feedback/proposals/:id/reanalyze]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.get('/api/ia-feedback/prompt-versions', async (req, res) => {
  try {
    const versions = await listVersions(process.env, { limit: 50 })
    res.json(versions)
  } catch (e) {
    console.error('[ia-feedback/prompt-versions]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.get('/api/ia-feedback/prompt-versions/:id', async (req, res) => {
  try {
    const version = await getVersionById(process.env, req.params.id)
    if (!version) return res.status(404).json({ error: 'Versão não encontrada' })
    res.json(version)
  } catch (e) {
    console.error('[ia-feedback/prompt-versions/:id]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.post('/api/ia-feedback/prompt-versions/:id/rollback', async (req, res) => {
  try {
    const newVersion = await rollbackToVersion(process.env, req.params.id)
    await refreshAgentRulesText(process.env).catch(() => {})
    res.json(newVersion)
  } catch (e) {
    console.error('[ia-feedback/prompt-versions/:id/rollback]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

app.post('/api/ia-feedback/prompt-versions/sync-from-fallback', async (req, res) => {
  try {
    const fallback = getFallbackAgentRulesText()
    const activeVersion = await getActiveVersion(process.env)
    if (activeVersion && activeVersion.agent_rules_text === fallback) {
      return res.status(400).json({
        error: `A versão ativa (v${activeVersion.versao}) já é idêntica ao fallback hardcoded — nenhuma sincronização necessária.`,
      })
    }
    const newVersion = await createVersionAndActivate(process.env, {
      agent_rules_text: fallback,
      created_by: 'manual_sync_from_fallback',
      diff_resumo: 'Sincronizado com FALLBACK_AGENT_RULES_TEXT hardcoded',
    })
    await refreshAgentRulesText(process.env).catch(() => {})
    res.json({ ok: true, new_version: { id: newVersion.id, versao: newVersion.versao } })
  } catch (e) {
    console.error('[ia-feedback/prompt-versions/sync-from-fallback]', e.message)
    res.status(500).json({ error: e.message, detail: e.stack?.split('\n')[1] })
  }
})

// ── Static files ──

app.use(express.static(join(__dirname, 'dist')))
app.get('*path', (_req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, async () => {
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

  const pollEnabledBoot = ['true', '1', 'yes'].includes(
    String(process.env.KOMMO_INBOUND_POLL_ENABLED || '').trim().toLowerCase(),
  )
  const pollModeBoot = normalizeKommoInboundPollMode(process.env.KOMMO_INBOUND_POLL_MODE)
  if (pollEnabledBoot && (pollModeBoot === 'dispatcher' || pollModeBoot === 'all')) {
    const fb = await maybeFallbackPollModeWhenDispatcherDown(process.env)
    if (fb.changed) {
      console.log(
        `[Server] Kommo inbound poll: enabled=true mode=${normalizeKommoInboundPollMode(process.env.KOMMO_INBOUND_POLL_MODE)} (fallback de "${fb.from}" porque dispatcher inacessivel)`,
      )
    } else {
      console.log(
        `[Server] Kommo inbound poll: enabled=true mode=${normalizeKommoInboundPollMode(process.env.KOMMO_INBOUND_POLL_MODE)} (${fb.reason || 'ok'})`,
      )
    }
  } else {
    console.log(
      `[Server] Kommo inbound poll: enabled=${pollEnabledBoot} mode=${pollModeBoot}`,
    )
  }

  const sched = startAgentScheduler(process.env)
  if (!sched.started) {
    console.log(`[Server] Agent scheduler: ${sched.reason}`)
  }

  startIaFeedbackRunner(process.env)

  // Otimizador de Prompt — seed da versão inicial e cache em memória
  await seedInitialVersionIfEmpty(process.env).catch((err) =>
    console.warn('[boot] seedInitialVersionIfEmpty falhou:', err.message),
  )
  await refreshAgentRulesText(process.env).catch((err) =>
    console.warn('[boot] refreshAgentRulesText falhou:', err.message),
  )
  setInterval(() => refreshAgentRulesText(process.env).catch(() => {}), 60_000)

  // Probe do dispatcher no boot — falha silenciosa é a pior coisa em
  // produção. Se modo=dispatcher e ele não estiver acessível, a IA
  // não vai responder mensagens novas. Logamos isso de forma BEM
  // visível para o operador detectar de imediato nos logs do EasyPanel,
  // mas NÃO derrubamos o processo (regra: outras rotas — health,
  // playground, salesbot — continuam úteis pra debug).
  const pollMode = normalizeKommoInboundPollMode(process.env.KOMMO_INBOUND_POLL_MODE)
  const pollEnabled = pollEnabledBoot
  if (pollEnabled && (pollMode === 'dispatcher' || pollMode === 'all')) {
    if (!process.env.KOMMO_DISPATCHER_URL) {
      console.warn(
        '[Server] AVISO: KOMMO_INBOUND_POLL_MODE=' + pollMode +
        ' mas KOMMO_DISPATCHER_URL nao foi definida. Caindo no default ' +
        'http://banco-kommo-dispatcher:8000. Se o servico no EasyPanel ' +
        'tem outro nome, defina KOMMO_DISPATCHER_URL no servico do agente.',
      )
    }
    checkDispatcherHealth(process.env).then((h) => {
      if (h.ok) {
        console.log(
          `[Server] dispatcher health OK upstream=${h.upstream} status=${h.status} elapsed=${h.elapsedMs}ms configuredFromEnv=${h.configuredFromEnv}`,
        )
        return
      }
      const banner = [
        '',
        '================================================================',
        ' DISPATCHER INACESSIVEL — IA NAO VAI RESPONDER LEADS NOVOS',
        '================================================================',
        ` URL tentada : ${h.upstream}`,
        ` Origem URL  : ${h.configuredFromEnv ? 'env KOMMO_DISPATCHER_URL' : 'default hardcoded (nenhuma env setada)'}`,
        ` Causa       : ${h.cause || 'desconhecida'}`,
        ` Erro        : ${h.error || 'n/a'}`,
        ` Tempo       : ${h.elapsedMs}ms`,
        ` Hint        : ${h.hint || 'verifique nome do servico, status e porta no EasyPanel.'}`,
        '',
        ' ACOES no EasyPanel:',
        '  1. Abra o projeto e confirme que o servico do dispatcher esta rodando.',
        '  2. Pegue o NOME EXATO do servico e a PORTA INTERNA dele.',
        '  3. No servico do AGENTE, defina:',
        '       KOMMO_DISPATCHER_URL=http://<nome-do-servico>:<porta>',
        '  4. Restart APENAS do servico do agente.',
        '  5. Confirme novamente neste log: deve aparecer "dispatcher health OK".',
        '',
        ' Salesbot e outras rotas continuam funcionando — a IA conversacional',
        ' por WhatsApp e que esta bloqueada ate isto ser resolvido.',
        '================================================================',
        '',
      ].join('\n')
      console.error(banner)
    }).catch((err) => {
      // Defesa contra exceção não capturada — o health check já não
      // deveria lançar, mas se lançar não deixamos o processo morrer.
      console.error('[Server] dispatcher health probe exception:', err?.message || err)
    })
  }
}).on('error', (err) => {
  console.error('[Server] Listen error:', err.message)
})
