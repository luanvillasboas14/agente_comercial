/**
 * Tool inscrição — espelha o subfluxo N8N em tool inscrição.txt
 *
 * Entradas do N8N (Execute Workflow Trigger):
 *   - telefone  → hoje costuma vir de $('Code').item.json.telefoneCorreto (integração pendente no app)
 *   - id_lead   → $('Edit Fields1').item.json.data._embedded.leads[0].id (CRM/Kommo — pendente)
 *   - Curso     → definido pelo modelo (orquestrador)
 *   - Tipo de ingresso → ENEM / Vestibular Múltipla Escolha (modelo)
 *
 * Quando telefone ou id_lead faltam, não chamamos Kommo/Supabase do fluxo completo;
 * retornamos MISSING_CRM_FIELDS para o modelo informar o usuário ou aguardar integração.
 *
 * Env (fluxo completo):
 *   KOMMO_BASE_URL          ex: https://admamoeduitcombr.kommo.com
 *   KOMMO_ACCESS_TOKEN      Bearer (long-lived / OAuth)
 *   KOMMO_SALESBOT_BOT_ID   ex: 46605
 *   KOMMO_PIPELINE_ID       funil (ex: 5481944) — mesmo pipeline para atendimento e aguardando inscrição
 *   KOMMO_STATUS_ID         etapa atendimento / fallback quando faltam nome ou nível (ex: 48539246)
 *   KOMMO_STATUS_AGUARDANDO_INSCRICAO opcional; default 99045180 (Aguardando Inscrição, mesmo funil)
 *   Sem nome+nível válidos no resumo: não dispara salesbot/formulário, não grava inscricao_ab, não pausa IA;
 *     só nota + PATCH em atendimento + distribuicao.
 *   INSCRICAO_TEST_OVERRIDES=true + body._test_nome_candidato + body._test_nivel — só para testar Kommo
 *     (nunca em produção).
 *   SUPABASE_URL + SUPABASE_KEY — projeto "BANCO AGENTE COMERCIAL" (tabelas abaixo)
 *
 * Tabelas Supabase usadas: inscricao_ab, dados_cliente, chat_messages, distribuicao_por_consultor
 */

const OPENAI_SUMMARY_MODEL = 'gpt-4.1-mini'

const KOMMO_FIELD_CURSO = 31782
const KOMMO_FIELD_NIVEL = 31786
const KOMMO_FIELD_NOME = 304628
const KOMMO_FIELD_POLO = 693837
const KOMMO_FIELD_TIPO_INGRESSO = 693843

/** Etapa Kommo “Aguardando inscrição” (mesmo pipeline_id que o restante do fluxo). */
const DEFAULT_STATUS_AGUARDANDO_INSCRICAO = 99045180

/** Valores vazios / “Não informado” / equivalentes → considerado ausente para regra de fallback. */
function isCampoAusente(val) {
  const t = String(val ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  if (!t) return true
  if (/^n[ãa]o informado\.?$/i.test(t)) return true
  if (/^n\/a$/i.test(t)) return true
  if (t === '-' || t === '—') return true
  return false
}

const SUMMARY_PROMPT_PREFIX = `Prompt para Agente de Resumo de Conversas
Você é um assistente especializado em resumir conversas do WhatsApp entre o assistente virtual comercial da Cruzeiro do Sul e candidatos.
Sua Tarefa
Analise a conversa completa abaixo e crie um resumo estruturado:
`

const SUMMARY_PROMPT_SUFFIX = `
Informações para Identificar

Nome do candidato: Procure por qualquer menção ao nome (completo ou primeiro nome)
Nível de interesse: Graduação, Pós-graduação ou Não informado
Curso específico: Nome exato do curso mencionado
Informações fornecidas: Valores, prazos, links, documentos, detalhes de inscrição
Status: Se o candidato ainda está respondendo ou parou de responder

Classificação de Níveis

Graduação: Bacharelado, licenciatura, tecnólogo (ex: Administração, Engenharia, Direito, Psicologia)
Pós-graduação: MBA, especialização, mestrado, doutorado
Não informado: Quando não fica claro o nível de interesse

Formato de Resposta Obrigatório
Resumo: [2-6 frases descrevendo o que aconteceu na conversa, incluindo nome do candidato se mencionado e principais informações fornecidas pelo assistente]
Nome do candidato: [Nome identificado ou "Não informado"]
Nível: [Graduação/Pós-graduação/Não informado]
Curso: [Nome do curso ou "Não informado"]
Informações fornecidas pela IA: [Liste as principais informações, orientações, valores, links ou documentos que a IA compartilhou com o candidato]
Status da conversa: [Candidato respondeu/Candidato parou de responder]
IMPORTANTE: Responda APENAS no formato acima, sem repetir estas instruções.`

function normalizeTelefone(t) {
  if (t == null) return ''
  return String(t).trim()
}

function normalizeIdLead(id) {
  if (id == null || id === '') return null
  const n = Number(id)
  return Number.isFinite(n) ? n : null
}

function extractField(text, fieldName, fieldNames) {
  const others = fieldNames.filter((f) => f !== fieldName).join('|')
  const regex = new RegExp(
    `${fieldName}:\\s*([\\s\\S]*?)(?=\\n(?:${others}):|$)`,
    'i',
  )
  const match = text.match(regex)
  return match ? match[1].trim().replace(/\s+/g, ' ') : ''
}

function parseResumoCampos(inputText) {
  const fieldNames = [
    'Resumo',
    'Nome do candidato',
    'Nível',
    'Nivel',
    'Curso',
    'Informações fornecidas pela IA',
    'Status da conversa',
    'Status',
  ]
  const resumo = extractField(inputText, 'Resumo', fieldNames) || 'Não informado'
  const nome = extractField(inputText, 'Nome do candidato', fieldNames) || 'Não informado'
  const nivel =
    extractField(inputText, 'Nível', fieldNames) ||
    extractField(inputText, 'Nivel', fieldNames) ||
    'Não informado'
  const curso = extractField(inputText, 'Curso', fieldNames) || 'Não informado'
  const infoIA =
    extractField(inputText, 'Informações fornecidas pela IA', fieldNames) || 'Não informado'
  const status =
    extractField(inputText, 'Status da conversa', fieldNames) ||
    extractField(inputText, 'Status', fieldNames) ||
    'Não informado'
  return {
    resumo,
    nome_candidato: nome,
    nivel,
    curso,
    informacoes_ia: infoIA,
    status_conversa: status,
    texto_original: inputText,
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

async function openaiSummarize(apiKey, conversation) {
  const prompt = SUMMARY_PROMPT_PREFIX + conversation + SUMMARY_PROMPT_SUFFIX
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: OPENAI_SUMMARY_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 1200,
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`OpenAI resumo ${res.status}: ${err.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.choices?.[0]?.message?.content || ''
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

/**
 * @param {string} [extraPrefer] — ex.: "resolution=merge-duplicates" (upsert em conflito de PK/unique)
 */
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

/**
 * @param {Record<string, string>} env
 * @param {object} body
 */
export async function runInscricao(env, body) {
  const curso = String(body?.curso ?? body?.Curso ?? '').trim()
  const tipoRaw = String(
    body?.tipo_ingresso ?? body?.tipoIngresso ?? body?.['Tipo de ingresso'] ?? '',
  ).trim()

  const telefone = normalizeTelefone(body?.telefone)
  const idLead = normalizeIdLead(body?.id_lead ?? body?.idLead)

  if (!curso || !tipoRaw) {
    return {
      ok: false,
      code: 'MISSING_PARAMS',
      error: 'Informe curso e tipo_ingresso (ENEM ou Vestibular Múltipla Escolha).',
    }
  }

  if (!telefone || idLead == null) {
    return {
      ok: false,
      code: 'MISSING_CRM_FIELDS',
      curso,
      tipo_ingresso: tipoRaw,
      telefone: telefone || null,
      id_lead: idLead,
      message:
        'Integração pendente: é necessário telefone (ex.: formato WhatsApp do lead) e id_lead (Kommo) ' +
        'para disparar o fluxo completo de inscrição. Os valores de curso e tipo de ingresso já foram recebidos e podem ser usados quando o CRM estiver ligado ao playground.',
    }
  }

  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const supabaseKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  const kommoBase = env.KOMMO_BASE_URL || ''
  const kommoToken = env.KOMMO_ACCESS_TOKEN || ''
  const botId = Number(env.KOMMO_SALESBOT_BOT_ID || 46605)
  const pipelineId = Number(env.KOMMO_PIPELINE_ID || 5481944)
  const statusId = Number(env.KOMMO_STATUS_ID || 48539246)
  const statusAguardandoInscricao = Number(
    env.KOMMO_STATUS_AGUARDANDO_INSCRICAO || DEFAULT_STATUS_AGUARDANDO_INSCRICAO,
  )
  const openaiKey = env.OPENAI_API_KEY

  if (!kommoBase || !kommoToken) {
    return {
      ok: false,
      code: 'KOMMO_NOT_CONFIGURED',
      error: 'Configure KOMMO_BASE_URL e KOMMO_ACCESS_TOKEN no servidor.',
    }
  }
  if (!supabaseUrl || !supabaseKey) {
    return {
      ok: false,
      code: 'SUPABASE_NOT_CONFIGURED',
      error: 'Configure SUPABASE_URL e SUPABASE_KEY (projeto com inscricao_ab, dados_cliente, chat_messages).',
    }
  }
  if (!openaiKey) {
    return { ok: false, code: 'OPENAI_NOT_CONFIGURED', error: 'OPENAI_API_KEY não configurada.' }
  }

  const steps = []
  const warnings = []

  // 1) chat_messages (antes do formulário / salesbot — precisamos saber se nome e nível existem)
  let messages = []
  try {
    const enc = encodeURIComponent(telefone)
    const rows = await supabaseRest(
      supabaseUrl,
      supabaseKey,
      'GET',
      `chat_messages?phone=eq.${enc}&select=*&order=created_at.asc&limit=500`,
    )
    messages = Array.isArray(rows) ? rows : []
    steps.push({ step: 'supabase_chat_messages', ok: true, count: messages.length })
  } catch (e) {
    warnings.push(`chat_messages: ${e.message}`)
    steps.push({ step: 'supabase_chat_messages', ok: false })
  }

  const conversation = buildConversationFromMessages(messages)
  let summaryText = ''
  let parsed = null
  if (conversation.trim()) {
    try {
      summaryText = await openaiSummarize(openaiKey, conversation)
      parsed = parseResumoCampos(summaryText)
      steps.push({ step: 'openai_resumo', ok: true })
    } catch (e) {
      warnings.push(`resumo: ${e.message}`)
      steps.push({ step: 'openai_resumo', ok: false, error: e.message })
    }
  } else {
    warnings.push('Sem mensagens em chat_messages para resumir.')
    parsed = {
      resumo: 'Sem histórico de chat disponível.',
      nome_candidato: 'Não informado',
      nivel: 'Não informado',
      curso,
      informacoes_ia: 'Não informado',
      status_conversa: 'Não informado',
      texto_original: '',
    }
    summaryText = `Resumo: Sem histórico de chat.\nNome do candidato: Não informado\nNível: Não informado\nCurso: ${curso}\nInformações fornecidas pela IA: Não informado\nStatus da conversa: Não informado`
  }

  if (!parsed) {
    warnings.push('Resumo não disponível; usando valores padrão para CRM.')
    parsed = {
      resumo: summaryText || `Inscrição — lead ${idLead}.`,
      nome_candidato: 'Não informado',
      nivel: 'Não informado',
      curso,
      informacoes_ia: 'Não informado',
      status_conversa: 'Não informado',
      texto_original: '',
    }
  }

  if (String(env.INSCRICAO_TEST_OVERRIDES || '').toLowerCase() === 'true') {
    const testNome = String(body?._test_nome_candidato ?? '').trim()
    const testNivel = String(body?._test_nivel ?? '').trim()
    if (testNome && testNivel) {
      parsed = { ...parsed, nome_candidato: testNome, nivel: testNivel }
      warnings.push(
        '[TESTE] Nome e nível vindos de _test_nome_candidato / _test_nivel — INSCRICAO_TEST_OVERRIDES não use em produção.',
      )
    }
  }

  const missingFields = []
  if (isCampoAusente(parsed.nome_candidato)) missingFields.push('Nome do candidato')
  if (isCampoAusente(parsed.nivel)) missingFields.push('Nível de interesse')

  const destino = missingFields.length === 0 ? 'aguardando_inscricao' : 'atendimento'

  // 2–4) Formulário (salesbot) + inscricao_ab + pause: somente se for para Aguardando Inscrição
  if (destino === 'aguardando_inscricao') {
    const salesbotRes = await kommoFetch(kommoBase, kommoToken, '/api/v2/salesbot/run', {
      method: 'POST',
      body: [{ entity_type: 'leads', entity_id: idLead, bot_id: botId }],
    })
    steps.push({ step: 'kommo_salesbot', ok: salesbotRes.ok, status: salesbotRes.status })
    if (!salesbotRes.ok) {
      return {
        ok: false,
        code: 'KOMMO_SALESBOT_FAILED',
        detail: salesbotRes.text.slice(0, 400),
        steps,
      }
    }

    try {
      await supabaseRest(
        supabaseUrl,
        supabaseKey,
        'POST',
        'inscricao_ab',
        [{ id_lead: idLead, Atendimento: 'IA' }],
        'resolution=merge-duplicates',
      )
      steps.push({ step: 'supabase_inscricao_ab', ok: true })
    } catch (e) {
      return { ok: false, code: 'SUPABASE_INSCRICAO_AB', error: e.message, steps }
    }

    try {
      const enc = encodeURIComponent(telefone)
      await supabaseRest(
        supabaseUrl,
        supabaseKey,
        'PATCH',
        `dados_cliente?telefone=eq.${enc}`,
        { atendimento_ia: 'pause' },
      )
      steps.push({ step: 'supabase_dados_cliente_pause', ok: true })
    } catch (e) {
      warnings.push(`dados_cliente: ${e.message}`)
      steps.push({ step: 'supabase_dados_cliente_pause', ok: false, error: e.message })
    }
  } else {
    steps.push({
      step: 'kommo_salesbot',
      ok: true,
      skipped: true,
      reason: 'dados_incompletos_nao_disparar_formulario',
    })
    steps.push({
      step: 'supabase_inscricao_ab',
      ok: true,
      skipped: true,
      reason: 'dados_incompletos_nao_disparar_formulario',
    })
    steps.push({
      step: 'supabase_dados_cliente_pause',
      ok: true,
      skipped: true,
      reason: 'dados_incompletos_nao_disparar_formulario',
    })
  }

  const nomeKommo =
    destino === 'aguardando_inscricao'
      ? String(parsed.nome_candidato).trim()
      : isCampoAusente(parsed.nome_candidato)
        ? 'Não informado'
        : String(parsed.nome_candidato).trim()
  const nivelKommo =
    destino === 'aguardando_inscricao'
      ? String(parsed.nivel).trim()
      : isCampoAusente(parsed.nivel)
        ? 'Não informado'
        : String(parsed.nivel).trim()
  const poloKommo = 'polo mais próximo'

  const targetPipeline = pipelineId
  const targetStatus = destino === 'aguardando_inscricao' ? statusAguardandoInscricao : statusId

  // 5) Notas no lead (Kommo v4)
  const notas = []
  if (parsed.resumo) {
    notas.push({ note_type: 'common', params: { text: String(parsed.resumo) } })
  }
  if (destino === 'atendimento' && missingFields.length > 0) {
    notas.push({
      note_type: 'common',
      params: {
        text:
          '[Inscrição automática] Lead mantido em atendimento: faltam dados para mover a Aguardando Inscrição. ' +
          'Formulário/template de inscrição (salesbot) não foi disparado. ' +
          'Pendências: ' +
          missingFields.join(', ') +
          '. Completar no CRM e, quando estiver pronto, mover manualmente para a etapa de inscrição.',
      },
    })
  }

  if (notas.length) {
    const noteRes = await kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}/notes`, {
      method: 'POST',
      body: notas,
    })
    steps.push({ step: 'kommo_note', ok: noteRes.ok, status: noteRes.status })
    if (!noteRes.ok) warnings.push(`kommo_note: ${noteRes.text.slice(0, 200)}`)
  }

  // 6) Atualizar lead (custom fields + pipeline / status)
  const customFields = [
    { field_id: KOMMO_FIELD_CURSO, values: [{ value: curso }] },
    { field_id: KOMMO_FIELD_NIVEL, values: [{ value: nivelKommo }] },
    { field_id: KOMMO_FIELD_NOME, values: [{ value: nomeKommo }] },
    { field_id: KOMMO_FIELD_POLO, values: [{ value: poloKommo }] },
    { field_id: KOMMO_FIELD_TIPO_INGRESSO, values: [{ value: tipoRaw }] },
  ]

  const patchRes = await kommoFetch(kommoBase, kommoToken, `/api/v4/leads/${idLead}`, {
    method: 'PATCH',
    body: {
      pipeline_id: targetPipeline,
      status_id: targetStatus,
      custom_fields_values: customFields,
    },
  })
  steps.push({ step: 'kommo_update_lead', ok: patchRes.ok, status: patchRes.status })
  if (!patchRes.ok) warnings.push(`kommo_update_lead: ${patchRes.text.slice(0, 300)}`)

  // 7) distribuicao_por_consultor — só quando fica em atendimento (fila de consultor)
  if (destino === 'atendimento') {
    try {
      await supabaseRest(
        supabaseUrl,
        supabaseKey,
        'POST',
        'distribuicao_por_consultor',
        [
          {
            id_lead: idLead,
            timestamp: new Date().toISOString(),
            origem: 'whatsapp',
          },
        ],
        'resolution=merge-duplicates',
      )
      steps.push({ step: 'supabase_distribuicao', ok: true })
    } catch (e) {
      warnings.push(`distribuicao_por_consultor: ${e.message}`)
      steps.push({ step: 'supabase_distribuicao', ok: false })
    }
  } else {
    steps.push({ step: 'supabase_distribuicao', ok: true, skipped: true })
  }

  const retorno =
    destino === 'aguardando_inscricao'
      ? 'Lead movido para Aguardando Inscrição.'
      : missingFields.length > 0
        ? 'Lead mantido em atendimento: faltam dados para inscrição automática (ver nota no lead).'
        : 'Lead mantido em atendimento (distribuição para consultor).'

  return {
    ok: true,
    retorno,
    destino,
    missing_fields: missingFields.length ? missingFields : undefined,
    curso,
    tipo_ingresso: tipoRaw,
    id_lead: idLead,
    resumo_campos: parsed,
    texto_resumo_ia: summaryText,
    warnings,
    steps,
  }
}

export function formatInscricaoToolReply(result) {
  if (!result.ok) {
    if (result.code === 'MISSING_CRM_FIELDS') {
      return [
        '[Inscrição — aguardando CRM]',
        result.message,
        `Curso recebido: ${result.curso}`,
        `Tipo de ingresso: ${result.tipo_ingresso}`,
        'Quando telefone e id_lead estiverem disponíveis no contexto do atendimento, o fluxo poderá disparar o template WhatsApp e atualizar Kommo/Supabase automaticamente.',
      ].join('\n')
    }
    return `Inscrição não executada: ${result.error || result.code || 'erro desconhecido'}`
  }
  const lines = [
    result.retorno || 'Inscrição processada.',
    `Curso: ${result.curso}`,
    `Tipo de ingresso: ${result.tipo_ingresso}`,
  ]
  if (result.destino === 'aguardando_inscricao') {
    lines.push('Destino no CRM: Aguardando Inscrição.')
  } else if (result.destino === 'atendimento') {
    lines.push('Destino no CRM: atendimento (consultor).')
  }
  if (result.missing_fields?.length) {
    lines.push(`Pendências registradas na nota: ${result.missing_fields.join(', ')}`)
  }
  if (result.resumo_campos?.resumo) {
    lines.push(`Resumo para o CRM: ${result.resumo_campos.resumo}`)
  }
  if (result.warnings?.length) {
    lines.push(`Avisos: ${result.warnings.join(' | ')}`)
  }
  return lines.join('\n')
}
