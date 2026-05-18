/**
 * Feedback IA — processamento de uma avaliação.
 *
 * Avalia se a IA seguiu as Rules 1–18 do prompt do agente numa conversa
 * com um lead, usando GPT como auditor de qualidade.
 *
 * Fonte de dados:
 *   - Leitura de chat_messages: Supabase principal (SUPABASE_URL / SUPABASE_KEY)
 *   - Gravação de resultados: Supabase de Feedback (SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK)
 */

import { resolveModel } from './ai/modelRegistry.js'
import { getAgentRulesText } from './ai/promptsLoader.js'

/* ───────────── Supabase REST wrapper (independente do feedbackJob.js) ───────────── */

async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(url, options)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`Timeout: ${options.method || 'GET'} ${url} não respondeu em ${timeoutMs}ms`)
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}

function makeSupabaseClient(url, key, { timeoutMs = 60_000 } = {}) {
  const baseHeaders = {
    'apikey': key,
    'Authorization': `Bearer ${key}`,
    'Content-Type': 'application/json',
  }

  async function request(method, path, body, extraHeaders = {}) {
    const res = await fetchWithTimeout(
      `${url}${path}`,
      {
        method,
        headers: { ...baseHeaders, ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
    )
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : null
  }

  return {
    select: (table, query = '') => request('GET', `/rest/v1/${table}${query ? '?' + query : ''}`),
    insert: (table, row, returning = false) =>
      request('POST', `/rest/v1/${table}`, row, returning ? { Prefer: 'return=representation' } : {}),
    update: (table, query, patch) =>
      request('PATCH', `/rest/v1/${table}?${query}`, patch, { Prefer: 'return=minimal' }),
  }
}

/* ───────────── Leitura de chat_messages ───────────── */

async function fetchChatMessages(env, { leadId, telefone }) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_KEY não configurados (necessário para ler chat_messages)')
  }

  const limit = Math.max(1, Number(env.IA_FEEDBACK_CONVERSA_LIMIT || 200))
  const table = env.SUPABASE_CHAT_MESSAGES_TABLE || 'chat_messages'
  const sb = makeSupabaseClient(url, key, { timeoutMs: 30_000 })

  // Preferência: filtrar por id_lead; fallback por phone
  let rows = []
  if (leadId) {
    rows = await sb.select(
      table,
      `select=*&id_lead=eq.${leadId}&order=created_at.asc.nullslast,id.asc&limit=${limit}`,
    )
  }

  if ((!rows || rows.length === 0) && telefone) {
    const phone = String(telefone).replace(/\D/g, '')
    rows = await sb.select(
      table,
      `select=*&phone=eq.${encodeURIComponent(telefone)}&order=created_at.asc.nullslast,id.asc&limit=${limit}`,
    )
    if (!rows || rows.length === 0) {
      // Tenta com número sem formatação
      rows = await sb.select(
        table,
        `select=*&phone=eq.${encodeURIComponent(phone)}&order=created_at.asc.nullslast,id.asc&limit=${limit}`,
      )
    }
  }

  return Array.isArray(rows) ? rows : []
}

/* ───────────── Formatação da conversa ───────────── */

function formatTimestamp(iso) {
  if (!iso) return ''
  try {
    const d = new Date(iso)
    return d.toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).replace(',', '')
  } catch {
    return String(iso).slice(0, 16)
  }
}

function buildConversaFormatada(messages) {
  const lines = []
  for (const msg of messages) {
    const ts = formatTimestamp(msg.created_at)
    const prefix = ts ? `[${ts}] ` : ''
    if (msg.user_message && String(msg.user_message).trim()) {
      lines.push(`${prefix}LEAD: ${String(msg.user_message).trim()}`)
    }
    if (msg.bot_message && String(msg.bot_message).trim()) {
      lines.push(`${prefix}IA: ${String(msg.bot_message).trim()}`)
    }
  }
  return lines.join('\n')
}

/* ───────────── Prompt do avaliador ───────────── */

const SYSTEM_PROMPT = `Você é um auditor de qualidade de uma IA de atendimento comercial.

Sua tarefa: receber as REGRAS que a IA tinha que seguir e a CONVERSA que ela teve com um lead via WhatsApp. Avaliar SE a IA seguiu cada regra.

INSTRUÇÕES:
- Avalie SOMENTE as mensagens da IA (linhas marcadas como "IA:"). Não julgue o lead.
- NÃO considere tempo de resposta — só conteúdo.
- Para cada regra que aparecer violada, cite a mensagem exata da IA e explique por quê.
- Severidade: "alta" (violação clara que prejudica o lead), "media" (violação parcial / ambígua), "baixa" (deslize pontual).
- Veredito final:
  • "aprovado" — nenhuma violação alta + no máximo 1 média.
  • "parcial" — 1 violação alta OU 2-3 médias.
  • "reprovado" — 2+ violações altas OU 4+ médias.
- Nota geral (0.0 a 10.0): considere quantidade e severidade das violações + qualidade geral do atendimento.

Responda APENAS um JSON válido neste formato (sem texto antes/depois):
{
  "nota_geral": 8.5,
  "veredito": "aprovado",
  "resumo_avaliacao": "Texto curto (1-3 frases) com a impressão geral.",
  "violacoes": [
    {
      "regra": "Rule 14",
      "titulo": "Preços",
      "descricao": "Por que isso foi violado",
      "citacao": "Mensagem exata da IA que evidencia",
      "severidade": "media"
    }
  ],
  "pontos_positivos": ["Item 1", "Item 2"]
}`

function buildUserPrompt(regrasText, conversaFormatada) {
  return `REGRAS QUE A IA TINHA QUE SEGUIR:

${regrasText}

══════════════════════════

CONVERSA COMPLETA (ordem cronológica):

${conversaFormatada}`
}

/* ───────────── Chamada OpenAI ───────────── */

async function callOpenAIEvaluator(env, { regrasText, conversaFormatada }) {
  const key = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || ''
  if (!key) {
    throw new Error('OPENAI_API_KEY não configurada (necessária para o Feedback IA)')
  }

  const model = resolveModel(env, 'ia_feedback')
  const url = 'https://api.openai.com/v1/chat/completions'
  const body = {
    model,
    temperature: 0.2,
    max_tokens: 2000,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserPrompt(regrasText, conversaFormatada) },
    ],
  }

  const timeoutMs = Number(env.IA_FEEDBACK_OPENAI_TIMEOUT_MS || 90_000)
  let lastErr = null

  for (let attempt = 0; attempt < 2; attempt++) {
    let res
    try {
      res = await fetchWithTimeout(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${key}`,
          },
          body: JSON.stringify(body),
        },
        timeoutMs,
      )
    } catch (e) {
      lastErr = e
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1500 + attempt * 2000))
        continue
      }
      throw e
    }

    if (res.ok) {
      const data = await res.json()
      const content = String(data?.choices?.[0]?.message?.content || '').trim()
      return { content, model }
    }

    const errText = await res.text().catch(() => '')
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`OpenAI ${res.status}: ${errText.slice(0, 400)}`)
      await new Promise((r) => setTimeout(r, 1500 + attempt * 2000))
      continue
    }
    lastErr = new Error(`OpenAI ${res.status}: ${errText.slice(0, 400)}`)
    break
  }

  throw lastErr || new Error('OpenAI: erro desconhecido')
}

function parseAIJson(text) {
  if (!text) return null
  const raw = String(text).trim()
  try { return JSON.parse(raw) } catch {}
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim()
  try { return JSON.parse(cleaned) } catch {}
  const m = cleaned.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

/* ───────────── Gravação ───────────── */

async function savePendente(sbFeedback, { leadId, telefone, detectedAt, motivo, conversa, jobExecutionId }) {
  await sbFeedback.insert('ia_feedback_pendente', {
    lead_id: leadId ?? null,
    telefone: telefone ?? null,
    detected_at: detectedAt instanceof Date ? detectedAt.toISOString() : detectedAt,
    motivo_pendencia: motivo,
    conversa_pendente: conversa ?? null,
    job_execution_id: jobExecutionId ?? null,
    created_at: new Date().toISOString(),
  })
}

async function saveAvaliacao(sbFeedback, {
  leadId, telefone, pipelineIdFrom, statusIdFrom, detectedAt,
  conversaCompleta, totalMensagens, totalTurnosIa,
  notaGeral, veredito, resumoAvaliacao, violacoes, pontosPositivos,
  modeloAvaliador, jobExecutionId,
}) {
  await sbFeedback.insert('ia_feedback', {
    lead_id: leadId ?? null,
    telefone: telefone ?? null,
    pipeline_id_from: pipelineIdFrom ?? null,
    status_id_from: statusIdFrom ?? null,
    detected_at: detectedAt instanceof Date ? detectedAt.toISOString() : detectedAt,
    evaluated_at: new Date().toISOString(),
    conversa_completa: conversaCompleta,
    total_mensagens: totalMensagens,
    total_turnos_ia: totalTurnosIa,
    nota_geral: notaGeral,
    veredito,
    resumo_avaliacao: resumoAvaliacao,
    violacoes,
    pontos_positivos: pontosPositivos,
    modelo_avaliador: modeloAvaliador,
    job_execution_id: jobExecutionId ?? null,
    created_at: new Date().toISOString(),
  })
}

/* ───────────── Função principal exportada ───────────── */

/**
 * Avalia a conversa de um lead que saiu do status monitorado.
 *
 * @param {object} env
 * @param {object} params
 * @param {number} params.leadId
 * @param {string} [params.telefone]
 * @param {number} [params.statusIdFrom]
 * @param {number} [params.pipelineIdFrom]
 * @param {Date} params.detectedAt
 * @param {string} [params.jobExecutionId]
 * @returns {Promise<{ok: boolean, action: string, motivo?: string, nota?: number, veredito?: string}>}
 */
export async function evaluateLead(env, {
  leadId,
  telefone,
  statusIdFrom,
  pipelineIdFrom,
  detectedAt,
  jobExecutionId,
}) {
  const fbUrl = (env.SUPABASE_URL_FEEDBACK || '').replace(/\/$/, '')
  const fbKey = env.SUPABASE_KEY_FEEDBACK || ''
  if (!fbUrl || !fbKey) {
    throw new Error('SUPABASE_URL_FEEDBACK / SUPABASE_KEY_FEEDBACK não configurados')
  }

  const sbFeedback = makeSupabaseClient(fbUrl, fbKey, { timeoutMs: 30_000 })
  const minTurns = Math.max(0, Number(env.IA_FEEDBACK_MIN_TURNS || 3))

  // 1. Lê histórico de chat_messages
  let messages = []
  try {
    messages = await fetchChatMessages(env, { leadId, telefone })
  } catch (err) {
    console.error(`[iaFeedbackJob] Erro ao buscar chat_messages para lead=${leadId}:`, err.message)
    await savePendente(sbFeedback, {
      leadId, telefone, detectedAt, motivo: 'ia_falhou',
      conversa: null, jobExecutionId,
    })
    return { ok: false, action: 'pendente', motivo: 'ia_falhou' }
  }

  // 2. Sem conversa
  if (!messages || messages.length === 0) {
    await savePendente(sbFeedback, {
      leadId, telefone, detectedAt, motivo: 'sem_conversa',
      conversa: null, jobExecutionId,
    })
    return { ok: true, action: 'pendente', motivo: 'sem_conversa' }
  }

  // 3. Conta turnos da IA (linhas com bot_message não vazio)
  const turnosIa = messages.filter(
    (m) => m.bot_message && String(m.bot_message).trim().length > 0,
  ).length

  if (turnosIa < minTurns) {
    await savePendente(sbFeedback, {
      leadId, telefone, detectedAt, motivo: 'conversa_curta',
      conversa: messages, jobExecutionId,
    })
    return { ok: true, action: 'pendente', motivo: 'conversa_curta' }
  }

  // 4. Monta conversa formatada
  const conversaFormatada = buildConversaFormatada(messages)

  // 5. Carrega regras do agente
  let regrasText = ''
  try {
    regrasText = getAgentRulesText()
  } catch (err) {
    console.warn('[iaFeedbackJob] Falha ao carregar regras do agente:', err.message)
    regrasText = '(regras não disponíveis neste momento)'
  }

  // 6. Chama OpenAI
  let aiResult = null
  let modeloAvaliador = resolveModel(env, 'ia_feedback')

  try {
    const { content, model } = await callOpenAIEvaluator(env, { regrasText, conversaFormatada })
    modeloAvaliador = model
    aiResult = parseAIJson(content)
  } catch (err) {
    console.error(`[iaFeedbackJob] Erro ao chamar OpenAI para lead=${leadId}:`, err.message)
    await savePendente(sbFeedback, {
      leadId, telefone, detectedAt, motivo: 'erro_modelo',
      conversa: messages, jobExecutionId,
    })
    return { ok: false, action: 'pendente', motivo: 'erro_modelo' }
  }

  // 7. Valida JSON
  if (!aiResult || typeof aiResult.nota_geral !== 'number' || !aiResult.veredito) {
    console.error(`[iaFeedbackJob] Resposta inválida da IA para lead=${leadId}:`, JSON.stringify(aiResult)?.slice(0, 200))
    await savePendente(sbFeedback, {
      leadId, telefone, detectedAt, motivo: 'erro_modelo',
      conversa: messages, jobExecutionId,
    })
    return { ok: false, action: 'pendente', motivo: 'erro_modelo' }
  }

  // 8. Grava em ia_feedback
  await saveAvaliacao(sbFeedback, {
    leadId,
    telefone,
    pipelineIdFrom,
    statusIdFrom,
    detectedAt,
    conversaCompleta: messages,
    totalMensagens: messages.length,
    totalTurnosIa: turnosIa,
    notaGeral: Number(aiResult.nota_geral),
    veredito: String(aiResult.veredito),
    resumoAvaliacao: String(aiResult.resumo_avaliacao || ''),
    violacoes: Array.isArray(aiResult.violacoes) ? aiResult.violacoes : [],
    pontosPositivos: Array.isArray(aiResult.pontos_positivos) ? aiResult.pontos_positivos : [],
    modeloAvaliador,
    jobExecutionId,
  })

  console.log(`[iaFeedbackJob] ✓ lead=${leadId} nota=${aiResult.nota_geral} veredito=${aiResult.veredito}`)

  return {
    ok: true,
    action: 'avaliado',
    nota: Number(aiResult.nota_geral),
    veredito: String(aiResult.veredito),
    turnosIa,
    totalMensagens: messages.length,
  }
}
