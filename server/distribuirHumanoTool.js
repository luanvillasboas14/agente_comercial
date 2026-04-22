/**
 * Tool distribuir_humano — espelha tool distribuir.txt (n8n Execute Workflow).
 *
 * Entradas: id_lead, telefone (Kommo + WhatsApp).
 * Supabase principal (AGENTE COMERCIAL): dados_cliente, chat_messages, distribuicao_por_consultor.
 * Supabase consultores: tabela distrib_comercial (projeto “acadêmico” — env separado).
 *
 * Env:
 *   KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN
 *   SUPABASE_URL, SUPABASE_KEY — principal (chat, dados_cliente, distribuicao_por_consultor)
 *   distrib_comercial: mesmo projeto do feedback por padrão (SUPABASE_*_FEEDBACK);
 *     ou override com SUPABASE_URL_DIST_COMERCIAL / SUPABASE_KEY_DIST_COMERCIAL
 *   OPENAI_API_KEY
 *   Opcionais: KOMMO_DISTRIB_* (IDs abaixo têm default do fluxo n8n)
 */

const OPENAI_MODEL = 'gpt-4o-mini'
const WAIT_BEFORE_LLM_MS = 5000

const DEFAULT_DISTRIB_PIPELINE_ID = 11685120
const DEFAULT_DISTRIB_STATUS_IDS = [89820300, 89820304]
const DEFAULT_ASSIGN_STATUS_ID = 89820300
const DEFAULT_FINAL_PIPELINE_ID = 5481944
const DEFAULT_FINAL_STATUS_ID = 48539246
const DEFAULT_FIELD_ORIGEM_SELECT = 686789
const KOMMO_FIELD_CURSO = 31782
const KOMMO_FIELD_NIVEL = 31786

const DISTRIB_PROMPT_PREFIX = `Prompt para Agente de Resumo de Conversas
Você é um assistente especializado em resumir conversas do WhatsApp entre o assistente virtual comercial da Cruzeiro do Sul e candidatos.

Sua Tarefa
Analise a conversa completa abaixo e crie um resumo estruturado:

`

const DISTRIB_PROMPT_SUFFIX = `

Informações para Identificar
INSTRUÇÕES CRÍTICAS DE ANÁLISE:

Leia TODA a conversa linha por linha antes de fazer o resumo
Extraia informações REAIS que aparecem nas mensagens, não invente ou generalize
Se o candidato mencionar seu nome em qualquer momento, capture-o
Se o candidato perguntar sobre um curso específico, identifique qual curso
Se o candidato perguntar sobre valores, isso indica interesse claro
NUNCA invente nomes de candidatos - use APENAS o nome que o próprio candidato informou explicitamente
NUNCA assuma informações que não foram trocadas - se o assistente não respondeu ainda, informe isso claramente
Identifique quem falou o quê - diferencie mensagens do candidato das mensagens do assistente/robô
O que procurar:

Nome do candidato: Qualquer menção ao nome (completo ou primeiro nome) nas mensagens do candidato ou quando o assistente se dirige ao candidato
Nível de interesse: Baseado no tipo de curso mencionado (graduação, pós-graduação)
Curso específico: Nome exato do curso que o candidato perguntou ou demonstrou interesse
Informações fornecidas: Valores específicos, prazos, links, documentos, detalhes de inscrição que o assistente compartilhou
Perguntas do candidato: O que especificamente o candidato quis saber
Status: Se o candidato ainda está respondendo ou parou de responder
REGRA CRÍTICA PARA CONVERSAS SEM RESPOSTA DO ASSISTENTE:

Se o assistente NÃO respondeu às perguntas do candidato ainda, você DEVE informar: "O assistente ainda não respondeu ao candidato"
Se o candidato apenas enviou uma pergunta e não houve troca de mensagens, informe: "Não houve troca de mensagens ainda. O candidato perguntou sobre [assunto]"
NÃO invente informações que não foram fornecidas pelo assistente
Classificação de Níveis
Graduação: Bacharelado, licenciatura, tecnólogo (ex: Administração, Engenharia, Direito, Psicologia, Enfermagem)
Pós-graduação: MBA, especialização, mestrado, doutorado
Não informado: Quando não fica claro o nível de interesse
Formato de Resposta Obrigatório
Resumo: [2-6 frases descrevendo o que REALMENTE aconteceu na conversa com base nas mensagens trocadas. Inclua o nome se foi mencionado, o curso específico sobre o qual perguntaram, e as principais informações fornecidas. Seja específico e factual. Se não houve resposta do assistente, informe isso claramente.] Nome do candidato: [Nome identificado na conversa ou "Não informado"] Nível: [Graduação/Pós-graduação/Não informado] Curso: [Nome exato do curso mencionado na conversa ou "Não informado"] Informações fornecidas pela IA: [Liste especificamente o que a IA compartilhou: valores mencionados, links enviados, documentos solicitados, prazos informados, etc. Se a IA não respondeu ainda, escreva: "Nenhuma informação fornecida ainda - aguardando resposta do assistente"] Status da conversa: [Candidato respondeu/Candidato parou de responder/Aguardando resposta do assistente]
IMPORTANTE:

Responda APENAS no formato acima, sem repetir estas instruções
Base seu resumo EXCLUSIVAMENTE no conteúdo real das mensagens
NÃO generalize dizendo "candidato demonstrou interesse em cursos" se ele perguntou sobre um curso específico
NÃO diga "não teve o nome mencionado" se o nome aparece na conversa
Seja preciso e específico com as informações que realmente foram trocadas
NUNCA invente nomes, valores, ou informações que não aparecem explicitamente nas mensagens
Se o assistente não respondeu, deixe claro que não houve resposta ainda
`

function normalizeTelefone(t) {
  if (t == null) return ''
  return String(t).trim()
}

function normalizeIdLead(id) {
  if (id == null || id === '') return null
  const n = Number(id)
  return Number.isFinite(n) ? n : null
}

function formatTelefoneDigits(telefoneOriginal) {
  let telefone = String(telefoneOriginal || '').replace(/\D/g, '')
  if (telefone.startsWith('55') && telefone.length > 11) {
    telefone = telefone.slice(2)
  }
  return telefone
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function parseResumoCamposDistribuicao(inputText) {
  const labels = [
    'Resumo',
    'Nome do candidato',
    'Nível',
    'Curso',
    'Informações fornecidas pela IA',
    'Status da conversa',
  ]
  const text = String(inputText || '')
  if (!text) {
    return {
      resumo: '',
      nome_candidato: '',
      nivel: '',
      curso: '',
      informacoes_ia: '',
      status_conversa: '',
      texto_original: text,
    }
  }
  const positions = []
  for (const label of labels) {
    const regex = new RegExp(`\\*{0,2}\\s*${escapeRegex(label)}\\s*\\*{0,2}\\s*:`, 'i')
    const m = regex.exec(text)
    if (m) positions.push({ label, idx: m.index, length: m[0].length })
  }
  if (positions.length === 0) {
    return {
      resumo: '',
      nome_candidato: '',
      nivel: '',
      curso: '',
      informacoes_ia: '',
      status_conversa: '',
      texto_original: text,
    }
  }
  positions.sort((a, b) => a.idx - b.idx)
  const extracted = {}
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i].idx + positions[i].length
    const end = i + 1 < positions.length ? positions[i + 1].idx : text.length
    const value = text
      .slice(start, end)
      .trim()
      .replace(/\s+\n\s+/g, '\n')
      .replace(/\s{2,}/g, ' ')
    extracted[positions[i].label] = value
  }
  return {
    resumo: extracted['Resumo'] || '',
    nome_candidato: extracted['Nome do candidato'] || '',
    nivel: extracted['Nível'] || '',
    curso: extracted['Curso'] || '',
    informacoes_ia: extracted['Informações fornecidas pela IA'] || '',
    status_conversa: extracted['Status da conversa'] || '',
    texto_original: text,
  }
}

function buildConversationFromMessages(rows) {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at),
  )
  return sorted
    .map((row) => {
      const u = row.user_message ? `Usuário: ${row.user_message}` : ''
      const b = row.bot_message ? `Bot: ${row.bot_message}` : ''
      return [u, b].filter(Boolean).join('\n')
    })
    .filter(Boolean)
    .join('\n\n')
}

function pickConsultorDistribuicao(rows, topN = 5) {
  const normNome = (v) => (v ?? '').trim().toLowerCase()
  const getKey = (j) => j.id_lead ?? normNome(j.nome ?? j.Nome)
  const getTs = (j) => {
    const s = j.ultimo_lead ?? j['Ultimo Lead'] ?? j.ultimoLead
    const t = Date.parse(s)
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
  }
  const byConsultor = new Map()
  for (let i = 0; i < rows.length; i++) {
    const j = rows[i]
    const keyRaw = getKey(j)
    const key = keyRaw == null || keyRaw === '' ? `__sem_chave_${i}` : String(keyRaw)
    const ts = getTs(j)
    const cur = byConsultor.get(key)
    if (!cur || ts < cur.ts) {
      byConsultor.set(key, { idx: i, row: j, ts })
    }
  }
  const unicos = Array.from(byConsultor.values())
  if (unicos.length === 0) throw new Error('Nenhum consultor disponível para distribuição.')
  unicos.sort((a, b) => a.ts - b.ts)
  const take = Math.min(topN, unicos.length)
  const candidatos = unicos.slice(0, take)
  return candidatos[Math.floor(Math.random() * candidatos.length)].row
}

async function kommoFetch(base, token, path, { method = 'GET', body } = {}) {
  const url = `${base.replace(/\/$/, '')}${path}`
  const res = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { ok: res.ok, status: res.status, text }
}

async function supabaseRest(url, key, method, pathAndQuery, body, extraPrefer) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
  }
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json'
    headers.Prefer = extraPrefer ? `return=minimal,${extraPrefer}` : 'return=minimal'
  }
  const res = await fetch(`${url.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${pathAndQuery} ${res.status}: ${text.slice(0, 220)}`)
  }
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return text
  }
}

async function openaiDistribuirResumo(apiKey, conversation) {
  const prompt = DISTRIB_PROMPT_PREFIX + conversation + DISTRIB_PROMPT_SUFFIX
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      max_tokens: 1200,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI ${res.status}: ${err.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
}

function parseLeadFromKommoGet(data) {
  const lead = data?._embedded?.leads?.[0] ?? (data?.id != null ? data : null)
  if (!lead || lead.id == null) return null
  return lead
}

/**
 * @param {Record<string, string>} env
 * @param {object} body
 */
export async function runDistribuirHumano(env, body) {
  const telefone = normalizeTelefone(body?.telefone)
  const idLead = normalizeIdLead(body?.id_lead ?? body?.idLead)

  if (!telefone || idLead == null) {
    return {
      ok: false,
      code: 'MISSING_CRM_FIELDS',
      message:
        'Informe telefone e id_lead (Kommo) para distribuir o atendimento humano.',
      telefone: telefone || null,
      id_lead: idLead,
    }
  }

  const kommoBase = env.KOMMO_BASE_URL || ''
  const kommoToken = env.KOMMO_ACCESS_TOKEN || ''
  const mainUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const mainKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  const distUrl =
    env.SUPABASE_URL_DIST_COMERCIAL ||
    env.SUPABASE_URL_FEEDBACK ||
    env.VITE_SUPABASE_URL_FEEDBACK ||
    ''
  const distKey =
    env.SUPABASE_KEY_DIST_COMERCIAL ||
    env.SUPABASE_KEY_FEEDBACK ||
    env.VITE_SUPABASE_KEY_FEEDBACK ||
    ''
  const openaiKey = env.OPENAI_API_KEY

  const distribPipelineId = Number(env.KOMMO_DISTRIB_PIPELINE_ID || DEFAULT_DISTRIB_PIPELINE_ID)
  const distribStatusIds = String(env.KOMMO_DISTRIB_STATUS_IDS || DEFAULT_DISTRIB_STATUS_IDS.join(','))
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n))
  const assignStatusId = Number(env.KOMMO_DISTRIB_ASSIGN_STATUS_ID || DEFAULT_ASSIGN_STATUS_ID)
  const finalPipelineId = Number(env.KOMMO_DISTRIB_FINAL_PIPELINE_ID || DEFAULT_FINAL_PIPELINE_ID)
  const finalStatusId = Number(env.KOMMO_DISTRIB_FINAL_STATUS_ID || DEFAULT_FINAL_STATUS_ID)
  const fieldOrigem = Number(env.KOMMO_FIELD_DIST_ORIGEM || DEFAULT_FIELD_ORIGEM_SELECT)
  const topN = Number(env.DIST_CONSULTOR_TOP_N || 5) || 5

  if (!kommoBase || !kommoToken) {
    return { ok: false, code: 'KOMMO_NOT_CONFIGURED', error: 'Configure KOMMO_BASE_URL e KOMMO_ACCESS_TOKEN.' }
  }
  if (!mainUrl || !mainKey) {
    return { ok: false, code: 'SUPABASE_NOT_CONFIGURED', error: 'Configure SUPABASE_URL e SUPABASE_KEY.' }
  }
  if (!distUrl || !distKey) {
    return {
      ok: false,
      code: 'DIST_COMERCIAL_NOT_CONFIGURED',
      error:
        'Configure tabela distrib_comercial: use SUPABASE_URL_FEEDBACK + SUPABASE_KEY_FEEDBACK (mesmo projeto do feedback) ' +
        'ou SUPABASE_URL_DIST_COMERCIAL + SUPABASE_KEY_DIST_COMERCIAL.',
    }
  }
  if (!openaiKey) {
    return { ok: false, code: 'OPENAI_NOT_CONFIGURED', error: 'OPENAI_API_KEY não configurada.' }
  }

  const steps = []
  const warnings = []

  const leadGet = await kommoFetch(
    kommoBase,
    kommoToken,
    `/api/v4/leads/${idLead}?with=contacts`,
    { method: 'GET' },
  )
  steps.push({ step: 'kommo_get_lead', ok: leadGet.ok, status: leadGet.status })
  if (!leadGet.ok) {
    return {
      ok: false,
      code: 'KOMMO_LEAD_NOT_FOUND',
      detail: leadGet.text.slice(0, 400),
      steps,
    }
  }

  let leadData
  try {
    leadData = JSON.parse(leadGet.text)
  } catch {
    return { ok: false, code: 'KOMMO_PARSE', error: 'Resposta inválida ao buscar lead.', steps }
  }

  const lead = parseLeadFromKommoGet(leadData)
  if (!lead) {
    return { ok: false, code: 'KOMMO_LEAD_EMPTY', error: 'Lead não encontrado na resposta.', steps }
  }

  const st = Number(lead.status_id)
  const pip = Number(lead.pipeline_id)
  const eligible =
    pip === distribPipelineId && distribStatusIds.includes(st)

  if (!eligible) {
    return {
      ok: false,
      code: 'LEAD_NOT_ELIGIBLE',
      message:
        `O lead precisa estar no funil ${distribPipelineId} com status ${distribStatusIds.join(' ou ')}. ` +
        `Atual: pipeline ${pip}, status ${st}.`,
      pipeline_id: pip,
      status_id: st,
      steps,
    }
  }

  const contactId = lead._embedded?.contacts?.[0]?.id
  if (contactId == null) {
    return { ok: false, code: 'KOMMO_NO_CONTACT', error: 'Lead sem contato embarcado (with=contacts).', steps }
  }

  let consultores
  try {
    consultores = await supabaseRest(
      distUrl,
      distKey,
      'GET',
      'distrib_comercial?status=eq.ATIVO&select=*',
    )
  } catch (e) {
    return { ok: false, code: 'SUPABASE_DIST_COMERCIAL', error: e.message, steps }
  }
  const rows = Array.isArray(consultores) ? consultores : []
  steps.push({ step: 'supabase_distrib_comercial', ok: true, count: rows.length })
  if (rows.length === 0) {
    return { ok: false, code: 'NO_CONSULTANTS', error: 'Nenhuma linha ATIVO em distrib_comercial.', steps }
  }

  let consultorRow
  try {
    consultorRow = pickConsultorDistribuicao(rows, topN)
  } catch (e) {
    return { ok: false, code: 'CONSULTOR_PICK', error: e.message, steps }
  }

  const consultorUserId = Number(consultorRow.id_lead)
  const consultorNome = String(consultorRow.nome ?? consultorRow.Nome ?? '').trim()
  const consultorTableId = consultorRow.id
  if (!Number.isFinite(consultorUserId)) {
    return { ok: false, code: 'CONSULTOR_INVALID', error: 'Consultor sem id_lead (Kommo user id) válido.', steps }
  }

  const ultimoLeadIso = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
  try {
    await supabaseRest(distUrl, distKey, 'PATCH', `distrib_comercial?id=eq.${consultorTableId}`, {
      ultimo_lead: ultimoLeadIso,
    })
    steps.push({ step: 'supabase_ultimo_lead', ok: true })
  } catch (e) {
    return { ok: false, code: 'SUPABASE_ULTIMO_LEAD', error: e.message, steps }
  }

  const customOrigem = []
  const enumId = env.KOMMO_DIST_ORIGEM_ENUM_ID
  if (enumId) {
    customOrigem.push({
      field_id: fieldOrigem,
      values: [{ enum_id: Number(enumId) }],
    })
  } else {
    customOrigem.push({
      field_id: fieldOrigem,
      values: [{ value: 'Recebida' }],
    })
  }

  const assignPatch = await kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}`, {
    method: 'PATCH',
    body: {
      pipeline_id: distribPipelineId,
      status_id: assignStatusId,
      responsible_user_id: consultorUserId,
      custom_fields_values: customOrigem,
    },
  })
  steps.push({ step: 'kommo_assign_lead', ok: assignPatch.ok, status: assignPatch.status })
  if (!assignPatch.ok) {
    warnings.push(`kommo_assign_lead: ${assignPatch.text.slice(0, 300)}`)
    return {
      ok: false,
      code: 'KOMMO_ASSIGN_LEAD_FAILED',
      detail: assignPatch.text.slice(0, 400),
      steps,
    }
  }

  const contactPatch = await kommoFetch(kommoBase, kommoToken, `/api/v4/contacts/${contactId}`, {
    method: 'PATCH',
    body: { responsible_user_id: consultorUserId },
  })
  steps.push({ step: 'kommo_assign_contact', ok: contactPatch.ok, status: contactPatch.status })
  if (!contactPatch.ok) {
    warnings.push(`kommo_assign_contact: ${contactPatch.text.slice(0, 200)}`)
  }

  try {
    const enc = encodeURIComponent(telefone)
    await supabaseRest(mainUrl, mainKey, 'PATCH', `dados_cliente?telefone=eq.${enc}`, {
      atendimento_ia: 'pause',
    })
    steps.push({ step: 'supabase_dados_cliente_pause', ok: true })
  } catch (e) {
    warnings.push(`dados_cliente: ${e.message}`)
    steps.push({ step: 'supabase_dados_cliente_pause', ok: false })
  }

  let messages = []
  const phoneQueries = [...new Set([telefone, formatTelefoneDigits(telefone), `+55${formatTelefoneDigits(telefone)}`])]
  for (const q of phoneQueries) {
    if (!q) continue
    try {
      const enc = encodeURIComponent(q)
      const rowsMsg = await supabaseRest(
        mainUrl,
        mainKey,
        'GET',
        `chat_messages?phone=eq.${enc}&select=*&order=created_at.asc&limit=500`,
      )
      if (Array.isArray(rowsMsg) && rowsMsg.length > 0) {
        messages = rowsMsg
        break
      }
    } catch {
      /* try next */
    }
  }
  steps.push({ step: 'supabase_chat_messages', ok: true, count: messages.length })

  const conversation = buildConversationFromMessages(messages)
  await new Promise((r) => setTimeout(r, WAIT_BEFORE_LLM_MS))

  let summaryText = ''
  let parsed
  if (conversation.trim()) {
    try {
      summaryText = await openaiDistribuirResumo(openaiKey, conversation)
      parsed = parseResumoCamposDistribuicao(summaryText)
      steps.push({ step: 'openai_resumo', ok: true })
    } catch (e) {
      warnings.push(`openai: ${e.message}`)
      steps.push({ step: 'openai_resumo', ok: false })
      parsed = parseResumoCamposDistribuicao('')
    }
  } else {
    warnings.push('Sem mensagens em chat_messages para resumir.')
    parsed = parseResumoCamposDistribuicao('')
  }

  const resumoNote = parsed.resumo || summaryText || 'Sem resumo automático.'
  const noteRes = await kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}/notes`, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text: resumoNote } }],
  })
  steps.push({ step: 'kommo_note', ok: noteRes.ok, status: noteRes.status })
  if (!noteRes.ok) warnings.push(`kommo_note: ${noteRes.text.slice(0, 200)}`)

  const cursoVal = parsed.curso || 'Não informado'
  const nivelVal = parsed.nivel || 'Não informado'

  const finalPatch = await kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}`, {
    method: 'PATCH',
    body: {
      pipeline_id: finalPipelineId,
      status_id: finalStatusId,
      custom_fields_values: [
        { field_id: KOMMO_FIELD_CURSO, values: [{ value: cursoVal }] },
        { field_id: KOMMO_FIELD_NIVEL, values: [{ value: nivelVal }] },
      ],
    },
  })
  steps.push({ step: 'kommo_final_lead', ok: finalPatch.ok, status: finalPatch.status })
  if (!finalPatch.ok) {
    warnings.push(`kommo_final_lead: ${finalPatch.text.slice(0, 300)}`)
  }

  const telefoneFormatado = formatTelefoneDigits(telefone)
  const ts = new Date().toISOString()
  const rowDistribuicao = {
    id_lead: idLead,
    consultor: consultorNome,
    timestamp: ts,
    origem: 'whatsapp',
    id_consultor: consultorUserId,
    telefone: telefoneFormatado,
  }
  try {
    await supabaseRest(
      mainUrl,
      mainKey,
      'POST',
      'distribuicao_por_consultor',
      [rowDistribuicao],
      'resolution=merge-duplicates',
    )
    steps.push({ step: 'supabase_distribuicao', ok: true })
  } catch (e) {
    if (String(e.message).includes('409')) {
      try {
        await supabaseRest(
          mainUrl,
          mainKey,
          'PATCH',
          `distribuicao_por_consultor?id_lead=eq.${idLead}`,
          {
            consultor: consultorNome,
            timestamp: ts,
            origem: 'whatsapp',
            id_consultor: consultorUserId,
            telefone: telefoneFormatado,
          },
        )
        steps.push({ step: 'supabase_distribuicao', ok: true, via: 'patch_id_lead' })
      } catch (e2) {
        warnings.push(`distribuicao_por_consultor: ${e2.message}`)
        steps.push({ step: 'supabase_distribuicao', ok: false })
      }
    } else {
      warnings.push(`distribuicao_por_consultor: ${e.message}`)
      steps.push({ step: 'supabase_distribuicao', ok: false })
    }
  }

  return {
    ok: true,
    retorno: 'atendimento distribuido para consultor',
    id_lead: idLead,
    consultor: consultorNome,
    id_consultor: consultorUserId,
    resumo_campos: parsed,
    texto_resumo_ia: summaryText,
    warnings,
    steps,
  }
}

export function formatDistribuirHumanoReply(result) {
  if (!result.ok) {
    if (result.code === 'MISSING_CRM_FIELDS') {
      return [result.message, 'Passe id_lead e telefone quando o CRM estiver ligado ao playground.'].join('\n')
    }
    if (result.code === 'LEAD_NOT_ELIGIBLE') {
      return result.message || 'Lead não está nas etapas elegíveis para distribuição humana.'
    }
    if (result.code === 'DIST_COMERCIAL_NOT_CONFIGURED') {
      return result.error
    }
    return `Distribuição não executada: ${result.error || result.code || 'erro'}`
  }
  const lines = [
    result.retorno || 'Distribuição concluída.',
    result.consultor ? `Consultor: ${result.consultor}` : null,
    result.id_consultor != null ? `ID consultor (Kommo): ${result.id_consultor}` : null,
  ].filter(Boolean)
  if (result.resumo_campos?.resumo) lines.push(`Resumo: ${result.resumo_campos.resumo}`)
  if (result.warnings?.length) lines.push(`Avisos: ${result.warnings.join(' | ')}`)
  return lines.join('\n')
}
