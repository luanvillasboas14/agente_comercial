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

/* ───────────── Leitura de mensagens_ia (execuções da IA) ───────────── */

/**
 * Busca execuções do agente (tabela mensagens_ia) para um lead.
 * Filtro: usage->>lead_id == leadId (campo dentro do JSONB usage).
 *
 * Cada execução tem:
 *   - id: 'EX-YYMMDD-HHMM-NNN'
 *   - response: texto que a IA gerou
 *   - tool_calls: array de tools chamadas [{ name: 'buscar_informacoes', ... }, ...]
 *   - created_at: timestamp
 *   - usage: { lead_id, telefone, ... }
 */
async function fetchAgentExecutions(env, { leadId, limit = 200 }) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  if (!url || !key || !leadId) return []

  const sb = makeSupabaseClient(url, key, { timeoutMs: 30_000 })
  try {
    // usage->>lead_id força string no JSONB; o Supabase aceita comparar com string
    const rows = await sb.select(
      'mensagens_ia',
      `select=id,response,tool_calls,created_at,usage&usage->>lead_id=eq.${leadId}&order=created_at.asc&limit=${Math.max(1, Number(limit))}`,
    )
    return Array.isArray(rows) ? rows : []
  } catch (err) {
    console.warn(`[iaFeedbackJob] Falha ao buscar mensagens_ia para lead=${leadId}: ${err.message}`)
    return []
  }
}

/**
 * Cruza chat_messages.bot_message com mensagens_ia.response/created_at.
 *
 * Estratégia (em ordem de prioridade):
 *   1. Match exato: response === bot_message
 *   2. Match por prefixo: response.startsWith(bot_message[0..80]) ou vice-versa
 *      (cobre casos onde houve trim/normalização entre a geração e a gravação)
 *   3. Match temporal: execução cujo created_at está dentro de ±120s do bot_message,
 *      em ordem cronológica, consumindo execuções já matched
 *
 * Retorna o mesmo array `messages` com 2 campos novos em cada item que teve match:
 *   - executionId: string (ex: 'EX-260519-1226-289')
 *   - toolsUsed: string[] (nomes únicos das tools chamadas)
 *
 * Mensagens sem match continuam sem esses campos (UI/prompt tratam ausência).
 */
function matchMessagesWithExecutions(messages, executions) {
  if (!Array.isArray(messages) || !Array.isArray(executions) || executions.length === 0) {
    return messages
  }

  const used = new Set()
  const findExactOrPrefix = (botMessage) => {
    const bm = String(botMessage || '').trim()
    if (!bm) return -1
    for (let i = 0; i < executions.length; i++) {
      if (used.has(i)) continue
      const resp = String(executions[i].response || '').trim()
      if (!resp) continue
      if (resp === bm) return i
      const prefixLen = Math.min(80, Math.min(resp.length, bm.length))
      if (prefixLen > 20 && resp.slice(0, prefixLen) === bm.slice(0, prefixLen)) return i
    }
    return -1
  }

  const findByTime = (createdAt) => {
    const t = new Date(createdAt).getTime()
    if (!Number.isFinite(t)) return -1
    let best = -1
    let bestDelta = Infinity
    for (let i = 0; i < executions.length; i++) {
      if (used.has(i)) continue
      const et = new Date(executions[i].created_at).getTime()
      if (!Number.isFinite(et)) continue
      const delta = Math.abs(et - t)
      if (delta < bestDelta && delta <= 120_000) {
        bestDelta = delta
        best = i
      }
    }
    return best
  }

  return messages.map((msg) => {
    if (!msg.bot_message || !String(msg.bot_message).trim()) return msg

    let idx = findExactOrPrefix(msg.bot_message)
    if (idx < 0) idx = findByTime(msg.created_at)
    if (idx < 0) return msg

    used.add(idx)
    const exec = executions[idx]
    const toolsRaw = Array.isArray(exec.tool_calls) ? exec.tool_calls : []
    const toolsUsed = [...new Set(toolsRaw.map((tc) => String(tc?.name || tc?.tool || '').trim()).filter(Boolean))]
    return { ...msg, executionId: exec.id, toolsUsed }
  })
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
      const idPart = msg.executionId ? ` (${msg.executionId})` : ''
      const toolsPart =
        Array.isArray(msg.toolsUsed) && msg.toolsUsed.length > 0
          ? ` [tools: ${msg.toolsUsed.join(', ')}]`
          : ' [tools: nao registrado]'
      lines.push(`${prefix}IA${idPart}${toolsPart}: ${String(msg.bot_message).trim()}`)
    }
  }
  return lines.join('\n')
}

/* ───────────── Prompt do avaliador ───────────── */

const SYSTEM_PROMPT = `Você é um auditor de qualidade de uma IA de atendimento comercial.

Sua tarefa: receber as REGRAS que a IA tinha que seguir e a CONVERSA que ela teve com um lead via WhatsApp. Avaliar SE a IA seguiu cada regra.

═══════════════════════════════════════════════════════════════
COMO LER A CONVERSA
═══════════════════════════════════════════════════════════════

Cada turno da IA aparece no formato:
  [data hora] IA (EX-XXX...) [tools: nome1, nome2]: texto da resposta

- O ID entre parênteses (ex: "EX-260519-1226-289") é o execution_id desse turno. Use-o para citar violações específicas.
- "[tools: ...]" lista as tools que a IA REALMENTE chamou nesse turno. Você DEVE confiar nessa lista, NÃO chutar.
- "[tools: nao registrado]" significa que não temos o log das tools para esse turno (não acuse "não usou X" nesses casos — você não sabe).

═══════════════════════════════════════════════════════════════
REGRAS DE OURO DA AVALIAÇÃO
═══════════════════════════════════════════════════════════════

1. Avalie SOMENTE as mensagens da IA. Não julgue o lead.
2. NÃO considere tempo de resposta — só conteúdo.
3. Quando "[tools: ...]" listar a tool X, a IA usou X. NÃO acuse a IA de "não ter usado a tool X" se ela está listada ali.
4. Quando "[tools: nao registrado]" aparecer, NÃO infira tools a partir do texto. Marque essa parte como "parcial" com severidade baixa em vez de "violação".

═══════════════════════════════════════════════════════════════
ATENÇÃO À REGRA 3 (buscar_perguntas) — EVITAR FALSO POSITIVO
═══════════════════════════════════════════════════════════════

A Regra 3 obriga buscar_perguntas em DÚVIDAS GERAIS — mas tem EXCEÇÕES IMPORTANTES.

NÃO é violação da Regra 3 quando:
- A IA respondeu sobre PREÇO, DURAÇÃO, MODALIDADE, GRADE ou ESTÁGIO de um CURSO ESPECÍFICO citado pelo lead (essas perguntas pedem buscar_informacoes / buscar_precos / buscar_pos, NÃO buscar_perguntas).
- A IA respondeu a cumprimento ("oi", "bom dia"), agradecimento ou despedida.
- A IA respondeu a confirmação curta do lead ("sim", "ok", "pode", "quero", "beleza"). A regra 16 manda PROGREDIR sem buscar de novo.
- A IA chamou distribuir_humano por pedido explícito do lead.

Exemplos do que NÃO é violação:
- Lead: "Quero saber sobre Administração" → IA chama buscar_informacoes e responde com curso, duração, modalidade. CORRETO.
- Lead: "Quanto custa Enfermagem?" → IA chama buscar_precos e responde. CORRETO.
- Lead: "Tem estágio em Farmácia?" → IA chama buscar_informacoes (que traz marcador [ESTAGIO]) e responde. CORRETO.

Só acuse Regra 3 violada quando o lead fizer pergunta GENÉRICA sobre processos da empresa (matrícula, prazos, formas de pagamento, dispensa de matérias, TCC, etc.) E a tool buscar_perguntas NÃO aparecer em [tools: ...] do turno em que a IA respondeu.

═══════════════════════════════════════════════════════════════
CONTRADIÇÕES INTERNAS — VIOLAÇÃO GRAVE (SEMPRE SEVERIDADE ALTA)
═══════════════════════════════════════════════════════════════

A IA disse uma coisa num turno e o oposto em outro? Isso é uma das piores violações possíveis. Procure ativamente.

Exemplos de contradições internas:
- Ofereceu enviar a grade ("Quer que eu te envie o link da grade?") e em seguida disse que não tem ("Infelizmente, não temos o link da grade disponível").
- Disse que tem desconto/bolsa num turno e que não tem em outro.
- Confirmou um preço e depois deu outro.
- Confirmou disponibilidade de polo/cidade e depois disse que não atende.

Quando achar contradição: registra como violação com regra="Coerência" (ou cite as regras envolvidas se forem mais de uma), severidade="alta", e cite AMBAS as mensagens da IA no campo descricao. No campo citacao, coloque a mensagem mais flagrante das duas.

═══════════════════════════════════════════════════════════════
VEREDITO E NOTA
═══════════════════════════════════════════════════════════════

- "aprovado" — nenhuma violação alta + no máximo 1 média.
- "parcial" — 1 violação alta OU 2-3 médias.
- "reprovado" — 2+ violações altas OU 4+ médias.
- Nota geral (0.0 a 10.0): considere quantidade e severidade das violações + qualidade geral do atendimento.

═══════════════════════════════════════════════════════════════
FORMATO DE SAÍDA (OBRIGATÓRIO)
═══════════════════════════════════════════════════════════════

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
      "execution_id": "EX-260519-1226-289",
      "severidade": "alta"
    }
  ],
  "pontos_positivos": ["Item 1", "Item 2"]
}

REGRAS DO CAMPO execution_id:
- DEVE ser o ID que aparece entre parênteses do turno onde a violação ocorreu (ex: "EX-260519-1226-289").
- Se a violação envolver vários turnos (contradição), coloque o ID do turno MAIS GRAVE (geralmente o que tem a citacao escolhida).
- Se o turno em questão não tinha ID registrado, deixe execution_id null.`

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
      // Erro de rede / timeout — categoriza pra ficar legível no banco
      lastErr = new Error(`[openai] ${e.message || 'erro de rede'} (modelo=${model})`)
      if (attempt < 1) {
        await new Promise((r) => setTimeout(r, 1500 + attempt * 2000))
        continue
      }
      throw lastErr
    }

    if (res.ok) {
      const data = await res.json()
      const content = String(data?.choices?.[0]?.message?.content || '').trim()
      return { content, model }
    }

    const errText = await res.text().catch(() => '')
    const summary = `[openai] HTTP ${res.status} (modelo=${model}): ${errText.slice(0, 400) || res.statusText || 'sem corpo'}`
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(summary)
      await new Promise((r) => setTimeout(r, 1500 + attempt * 2000))
      continue
    }
    lastErr = new Error(summary)
    break
  }

  throw lastErr || new Error('[openai] erro desconhecido')
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

  // Helper local: grava o erro como linha de ia_feedback (veredito='erro').
  // Se o próprio save falhar (RLS, timeout, etc.), loga sem propagar — assim
  // o runner ainda fecha a run e o motivo aparece no console mesmo sem o
  // registro persistido (não tem como gravar erro de gravação no mesmo lugar).
  async function persistErro(resumo, conversa, totalMsgs, turnos) {
    try {
      await saveAvaliacao(sbFeedback, {
        leadId, telefone, pipelineIdFrom, statusIdFrom, detectedAt,
        conversaCompleta: conversa,
        totalMensagens: totalMsgs,
        totalTurnosIa: turnos,
        notaGeral: null,
        veredito: 'erro',
        resumoAvaliacao: resumo,
        violacoes: [],
        pontosPositivos: [],
        modeloAvaliador: resolveModel(env, 'ia_feedback'),
        jobExecutionId,
      })
    } catch (saveErr) {
      console.error(
        `[iaFeedbackJob] FALHA AO GRAVAR registro de erro para lead=${leadId}. ` +
        `Erro original: "${resumo}". Erro do save: "${saveErr.message}"`,
      )
    }
  }

  // 1. Lê histórico de chat_messages
  let messages = []
  try {
    messages = await fetchChatMessages(env, { leadId, telefone })
  } catch (err) {
    const resumo = `[chat_messages] ${err.message || 'falha desconhecida'} (lead_id=${leadId}, telefone=${telefone || 'n/a'})`
    console.error(`[iaFeedbackJob] ${resumo}`)
    await persistErro(resumo, null, 0, 0)
    return { ok: false, action: 'erro', motivo: 'ia_falhou' }
  }

  // 2. Sem conversa
  if (!messages || messages.length === 0) {
    console.log(`[iaFeedbackJob] lead=${leadId} sem conversa — skipped`)
    return { ok: true, action: 'skipped', motivo: 'sem_conversa' }
  }

  // 1.5 — Busca execuções da IA e cruza com bot_message do chat_messages.
  //       Adiciona executionId + toolsUsed em cada turno da IA quando há match.
  let executions = []
  try {
    executions = await fetchAgentExecutions(env, { leadId, limit: Number(env.IA_FEEDBACK_CONVERSA_LIMIT || 200) })
  } catch (err) {
    console.warn(`[iaFeedbackJob] Falha ao buscar execuções para lead=${leadId}: ${err.message}`)
  }
  messages = matchMessagesWithExecutions(messages, executions)

  // 3. Conta turnos da IA (linhas com bot_message não vazio)
  const turnosIa = messages.filter(
    (m) => m.bot_message && String(m.bot_message).trim().length > 0,
  ).length

  if (turnosIa < minTurns) {
    console.log(`[iaFeedbackJob] lead=${leadId} conversa curta (${turnosIa} turnos) — skipped`)
    return { ok: true, action: 'skipped', motivo: 'conversa_curta' }
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
  let rawAIContent = ''
  let modeloAvaliador = resolveModel(env, 'ia_feedback')

  try {
    const { content, model } = await callOpenAIEvaluator(env, { regrasText, conversaFormatada })
    modeloAvaliador = model
    rawAIContent = content
    aiResult = parseAIJson(content)
  } catch (err) {
    const resumo = err.message?.startsWith('[openai]') ? err.message : `[openai] ${err.message || 'erro desconhecido'}`
    console.error(`[iaFeedbackJob] lead=${leadId} ${resumo}`)
    await persistErro(resumo, messages, messages.length, turnosIa)
    return { ok: false, action: 'erro', motivo: 'erro_modelo' }
  }

  // 7. Valida JSON
  if (!aiResult) {
    const excerpt = rawAIContent.slice(0, 300).replace(/\s+/g, ' ').trim()
    const resumo = `[parser] resposta da IA nao e JSON valido. Excerpt: "${excerpt || '(vazio)'}"`
    console.error(`[iaFeedbackJob] lead=${leadId} ${resumo}`)
    await persistErro(resumo, messages, messages.length, turnosIa)
    return { ok: false, action: 'erro', motivo: 'erro_modelo' }
  }

  // 7b. JSON existe mas faltam campos obrigatórios — discrimina o que faltou.
  if (typeof aiResult.nota_geral !== 'number' || !aiResult.veredito) {
    const faltou = []
    if (typeof aiResult.nota_geral !== 'number') faltou.push(`nota_geral=${JSON.stringify(aiResult.nota_geral)}`)
    if (!aiResult.veredito) faltou.push(`veredito=${JSON.stringify(aiResult.veredito)}`)
    const got = JSON.stringify(aiResult).slice(0, 200)
    const resumo = `[parser] JSON valido mas faltam campos obrigatorios: ${faltou.join(', ')}. Got: ${got}`
    console.error(`[iaFeedbackJob] lead=${leadId} ${resumo}`)
    await persistErro(resumo, messages, messages.length, turnosIa)
    return { ok: false, action: 'erro', motivo: 'erro_modelo' }
  }

  // 7c. Veredito veio mas fora do conjunto esperado — registra como erro e mantém a nota crua.
  const VEREDITOS_VALIDOS = new Set(['aprovado', 'parcial', 'reprovado'])
  const veredictoNormalizado = String(aiResult.veredito).toLowerCase().trim()
  if (!VEREDITOS_VALIDOS.has(veredictoNormalizado)) {
    const resumo = `[parser] veredito invalido retornado pela IA: "${aiResult.veredito}" (esperado: aprovado|parcial|reprovado)`
    console.error(`[iaFeedbackJob] lead=${leadId} ${resumo}`)
    await persistErro(resumo, messages, messages.length, turnosIa)
    return { ok: false, action: 'erro', motivo: 'erro_modelo' }
  }

  // 8. Grava em ia_feedback
  try {
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
      veredito: veredictoNormalizado,
      resumoAvaliacao: String(aiResult.resumo_avaliacao || ''),
      violacoes: Array.isArray(aiResult.violacoes)
        ? aiResult.violacoes.map((v) => ({
            regra: String(v.regra || ''),
            titulo: String(v.titulo || ''),
            descricao: String(v.descricao || ''),
            citacao: String(v.citacao || ''),
            execution_id: v.execution_id ? String(v.execution_id) : null,
            severidade: String(v.severidade || 'media').toLowerCase(),
          }))
        : [],
      pontosPositivos: Array.isArray(aiResult.pontos_positivos) ? aiResult.pontos_positivos : [],
      modeloAvaliador,
      jobExecutionId,
    })
  } catch (saveErr) {
    // Avaliação rodou OK na IA mas falhou ao gravar. Tenta gravar como erro
    // (persistErro tem try/catch interno — se falhar de novo, só loga).
    const resumo = `[supabase] falha ao gravar avaliacao bem-sucedida: ${saveErr.message}`
    console.error(`[iaFeedbackJob] lead=${leadId} ${resumo}`)
    await persistErro(resumo, messages, messages.length, turnosIa)
    return { ok: false, action: 'erro', motivo: 'erro_modelo' }
  }

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
