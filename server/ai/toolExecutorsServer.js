/**
 * Executores das tools no lado servidor — chamam direto os módulos locais
 * (sem HTTP). Use em conjunto com TOOL_DEFINITIONS.
 *
 * Recebem opcionalmente um `executionContext` (ver
 * `./executionContext.js`) para empurrar usage de sub-chamadas LLM
 * (query rewrite, resumo de inscrição, distribuir humano, embeddings)
 * — assim o dashboard mostra o custo total honesto da execução.
 */

import { runNearestPolo } from '../locationTool.js'
import { runInscricao } from '../inscricaoTool.js'
import { runDistribuirHumano } from '../distribuirHumanoTool.js'
import { runBuscarHistorico } from '../memoryTool.js'
import { resolveModel } from './modelRegistry.js'
import { rewriteSearchQuery } from './queryRewrite.js'
import { createNoopExecutionContext } from './executionContext.js'

async function getEmbedding(env, text, ctx, toolName) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  const model = resolveModel(env, 'embeddings')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, input: text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Embedding ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  // Embeddings devolvem usage.prompt_tokens (e total_tokens), sem
  // completion_tokens. Empurra no aiMeta pra contabilizar custo.
  if (ctx && data.usage) {
    ctx.recordEmbeddingsUsage({ model, tool: toolName, usage: data.usage })
  }
  return data.data[0].embedding
}

/**
 * Extrai o link da grade curricular do metadata, se preenchido.
 * Usado por `buscar_informacoes` e `buscar_pos` — a base `documents`
 * tem `metadata.grade_do_curso` com URL (Drive) em alguns cursos.
 *
 * Sem isso o LLM não sabe se o link existe e tende a oferecer "te
 * mando o link" mesmo quando não tem. Ao injetar o link no texto
 * (quando existe) e marcar explicitamente quando NÃO existe, o LLM
 * pode decidir certo (ver promptsLoader regra 13).
 */
function extractGradeLink(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const raw =
    metadata.grade_do_curso ||
    metadata.grade_curso ||
    metadata.link_grade ||
    metadata.gradeCurricular ||
    null
  if (!raw) return null
  const s = String(raw).trim()
  if (!s) return null
  // Aceita só se realmente parece URL — evita "N/A", "—", "ver site" virarem link.
  if (!/^https?:\/\//i.test(s)) return null
  return s
}

/**
 * Extrai a info estruturada de estágio do metadata, se preenchida.
 * Espera-se metadata.estagio = { tem: boolean, quantidade?, carga_total_horas?, detalhe? }.
 *
 * Retorna null se ausente ou inválido. Sem esse marcador a IA segue a
 * Rule 18 do prompt e chama distribuir_humano quando perguntada sobre
 * estágio — não inventa.
 */
function extractEstagioInfo(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const raw = metadata.estagio
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.tem !== 'boolean') return null
  const out = { tem: raw.tem }
  if (raw.tem === true) {
    if (Number.isFinite(Number(raw.quantidade))) out.quantidade = Number(raw.quantidade)
    if (Number.isFinite(Number(raw.carga_total_horas))) out.carga_total_horas = Number(raw.carga_total_horas)
    if (typeof raw.detalhe === 'string' && raw.detalhe.trim()) out.detalhe = raw.detalhe.trim()
    if (typeof raw.observacao === 'string' && raw.observacao.trim()) out.observacao = raw.observacao.trim()
  }
  return out
}

/**
 * Monta o texto do marcador [ESTAGIO: ...] a partir do extract.
 * Retorna a parte INTERNA — o caller envolve em colchetes (igual ao
 * padrão de STATUS DA GRADE).
 */
function formatEstagioMarker(info) {
  if (!info) return null
  if (info.tem === false) {
    return 'ESTAGIO: NAO — nao ha disciplina de estagio supervisionado obrigatorio neste curso'
  }
  // tem === true a partir daqui
  const partes = []
  if (info.quantidade != null) partes.push(`${info.quantidade} disciplina${info.quantidade === 1 ? '' : 's'} obrigatoria${info.quantidade === 1 ? '' : 's'}`)
  if (info.carga_total_horas != null) partes.push(`${info.carga_total_horas}h totais`)
  const head = partes.length > 0 ? partes.join(', ') : 'estagio supervisionado obrigatorio'
  let texto = `ESTAGIO: SIM — ${head}`
  if (info.detalhe) texto += `. ${info.detalhe}`
  if (info.observacao) texto += ` (${info.observacao})`
  return texto
}

/**
 * Procura, recursivamente em qualquer profundidade do metadata, valores
 * pra um conjunto de chaves alvo — case-insensitive. Aceita strings JSON
 * aninhadas (como `metadata.Metadata` que é uma string `{"curso":...}`)
 * e desserializa automaticamente. Para na primeira ocorrência de cada chave.
 *
 * Sem essa varredura recursiva a função antiga falhava em qualquer
 * variação de formato (PascalCase, snake_case, JSON dentro de string,
 * objetos aninhados via loaders do n8n/LangChain), e a IA recebia só
 * "Gestão R$ 200" sem saber se era graduação ou pós.
 */
function deepFindKeys(obj, targets, found = {}, depth = 0) {
  if (!obj || depth > 6) return found
  if (typeof obj === 'string') {
    const trimmed = obj.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return deepFindKeys(JSON.parse(trimmed), targets, found, depth + 1)
      } catch { /* ignore */ }
    }
    return found
  }
  if (Array.isArray(obj)) {
    for (const item of obj) deepFindKeys(item, targets, found, depth + 1)
    return found
  }
  if (typeof obj !== 'object') return found
  for (const [k, v] of Object.entries(obj)) {
    const lower = k.toLowerCase()
    for (const [outKey, aliases] of Object.entries(targets)) {
      if (found[outKey] != null) continue
      if (aliases.includes(lower)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
          const s = String(v).trim()
          if (s) found[outKey] = s
        }
      }
    }
    if (typeof v === 'object' || (typeof v === 'string' && v.trim().startsWith('{'))) {
      deepFindKeys(v, targets, found, depth + 1)
    }
  }
  return found
}

/**
 * Extrai info de preço do metadata de documents_precos. Tenta vários
 * formatos (PascalCase, snake_case, JSON dentro de string, objeto
 * aninhado).
 *
 * Sem isso a IA só recebia "Gestão Ambiental R$ 184,00" sem nivel/
 * modalidade e juntava preços de graduação com pós (caso real do print).
 */
function extractPriceMeta(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const found = deepFindKeys(metadata, {
    curso: ['curso', 'nome', 'nome_curso', 'course', 'name'],
    tipo: ['tipo', 'nivel', 'grau', 'grau_curso', 'level', 'category'],
    modalidade: ['modalidade', 'modalidades', 'modality'],
    tempo: ['tempo', 'duracao', 'duracao_curso', 'duration'],
    valor: ['valor', 'preco', 'preco_mensal', 'mensalidade', 'price'],
  })
  if (!found.curso && !found.tipo && !found.modalidade && !found.tempo && !found.valor) return null
  return found
}

function isPosTipo(tipo) {
  if (!tipo) return false
  const t = String(tipo).toLowerCase()
  return /(p[óo]s|mba|especializa)/i.test(t)
}

/**
 * Fallback: serializa o metadata em string compacta (até ~250 chars) pra
 * a IA ter pelo menos UMA visão dos campos brutos quando o extrator
 * canônico falha. Remove campos de loader (loc, source, blobType, etc)
 * que só poluem o prompt.
 */
const NOISE_KEYS = new Set([
  'loc', 'source', 'blobtype', 'pdf', 'pageNumber', 'totalPages',
  'lines', 'embedding', 'id',
])
function summarizeMetadataForLLM(metadata) {
  if (!metadata || typeof metadata !== 'object') return null
  const cleaned = {}
  for (const [k, v] of Object.entries(metadata)) {
    if (NOISE_KEYS.has(k.toLowerCase())) continue
    if (v == null) continue
    if (typeof v === 'string') {
      // Se for JSON-string, tenta parsear pra exibir mais legível.
      const t = v.trim()
      if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
        try { cleaned[k] = JSON.parse(t); continue } catch { /* ignore */ }
      }
      cleaned[k] = v
    } else {
      cleaned[k] = v
    }
  }
  if (Object.keys(cleaned).length === 0) return null
  let s
  try { s = JSON.stringify(cleaned) } catch { return null }
  if (s.length > 280) s = s.slice(0, 277) + '...'
  return s
}

async function vectorSearch(env, ctx, toolName, rpcName, query, matchCount = 10, opts = {}) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!url || !key) return 'Supabase não configurado no servidor.'

  // Etapa 1 — opcional: reescreve a pergunta do cliente em uma query
  // melhor antes da busca vetorial. Conservadora: fallback p/ original
  // em qualquer sinal de dúvida (ver server/ai/queryRewrite.js).
  const rw = await rewriteSearchQuery(env, { rawQuery: query, toolName })
  if (ctx && rw.usage) {
    ctx.recordQueryRewriteUsage({ model: rw.model, tool: toolName, usage: rw.usage })
  }
  const finalQuery = rw.applied ? rw.query : query
  if (rw.applied) {
    console.log(`[tool/${toolName}] queryRewrite: "${query}" → "${finalQuery}"`)
  } else if (rw.reason) {
    console.log(`[tool/${toolName}] queryRewrite skip: ${rw.reason}`)
  }
  // Empilha o trace pra o agentRunner colocar dentro do step.queryRewrite
  // — assim a aba "Execuções" mostra exatamente o que a reescrita fez.
  if (ctx) {
    ctx.recordToolTrace(toolName, {
      applied: rw.applied,
      query: finalQuery,
      originalQuery: rw.originalQuery || query,
      model: rw.model,
      reason: rw.reason || null,
      usage: rw.usage || null,
      elapsedMs: rw.elapsedMs || 0,
    })
  }

  const embedding = await getEmbedding(env, finalQuery, ctx, toolName)
  const res = await fetch(`${url}/rest/v1/rpc/${rpcName}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ query_embedding: embedding, filter: {}, match_count: matchCount }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Supabase RPC ${rpcName} ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  if (!Array.isArray(data) || data.length === 0) return 'Nenhum resultado encontrado na base.'

  if (toolName === 'buscar_precos') {
    let nGrad = 0, nPos = 0, nOutro = 0
    for (const d of data) {
      const meta = extractPriceMeta(d?.metadata)
      if (!meta?.tipo) { nOutro++; continue }
      if (isPosTipo(meta.tipo)) nPos++; else nGrad++
    }
    console.log(
      `[tool/buscar_precos/breakdown] query="${String(finalQuery).slice(0, 80)}" ` +
      `total=${data.length} graduacao=${nGrad} pos=${nPos} sem_nivel=${nOutro}`,
    )
  }

  // Filtro por nivel quando a IA passou o parametro.
  // Usa extractPriceMeta + isPosTipo (ja importados/definidos no arquivo).
  const nivelFiltro = String(opts?.nivel || '').toLowerCase().trim()
  let dataFiltered = data
  if (toolName === 'buscar_precos' && (nivelFiltro === 'graduacao' || nivelFiltro === 'pos')) {
    const ehPos = nivelFiltro === 'pos'
    dataFiltered = data.filter((d) => {
      const meta = extractPriceMeta(d?.metadata)
      if (!meta?.tipo) return false // sem nivel definido = nao garante = descartado
      return isPosTipo(meta.tipo) === ehPos
    })
    console.log(
      `[tool/buscar_precos/filter] nivel="${nivelFiltro}" antes=${data.length} depois=${dataFiltered.length}`,
    )
    if (dataFiltered.length === 0) {
      return `Nenhum resultado encontrado na base para esse curso no nivel ${nivelFiltro === 'pos' ? 'pos-graduacao' : 'graduacao'}. Verifique se o curso existe nesse nivel ou ofereca transferir para um consultor.`
    }
  }

  // Anexa metadata legível ao texto pra o LLM — sem isso ele perdia
  // contexto crítico (link da grade, nível/modalidade do preço) e
  // alucinava (oferecia link inexistente, juntava preço de graduação
  // com preço de pós, etc).
  const isCourseTool = toolName === 'buscar_informacoes' || toolName === 'buscar_pos'
  const isPriceTool = toolName === 'buscar_precos'
  return dataFiltered
    .map((d) => {
      const base = d?.content || ''
      if (isCourseTool) {
        const partes = [base]

        const gradeUrl = extractGradeLink(d?.metadata)
        const gradeStatus = gradeUrl
          ? `STATUS DA GRADE: DISPONIVEL — link oficial: ${gradeUrl}`
          : 'STATUS DA GRADE: NAO DISPONIVEL — não existe link/PDF da grade deste curso na nossa base.'
        partes.push(`[${gradeStatus}]`)

        // Marcador de estágio: só pra graduação (buscar_informacoes).
        // Pós-graduação raramente tem estágio supervisionado — não inflar o
        // prompt nem confundir a IA com info que não tem campo preenchido.
        if (toolName === 'buscar_informacoes') {
          const estagioInfo = extractEstagioInfo(d?.metadata)
          const estagioMarker = formatEstagioMarker(estagioInfo)
          if (estagioMarker) partes.push(`[${estagioMarker}]`)
        }

        return partes.join('\n\n')
      }
      if (isPriceTool) {
        const meta = extractPriceMeta(d?.metadata)
        const lines = [base]
        if (meta) {
          const fields = []
          if (meta.curso) fields.push(`curso: ${meta.curso}`)
          if (meta.tipo) {
            const nivel = isPosTipo(meta.tipo) ? 'PÓS-GRADUAÇÃO' : 'GRADUAÇÃO'
            fields.push(`nivel: ${nivel} (tipo bruto: ${meta.tipo})`)
          }
          if (meta.modalidade) fields.push(`modalidade: ${meta.modalidade}`)
          if (meta.tempo) fields.push(`duracao: ${meta.tempo}`)
          if (meta.valor) fields.push(`valor: ${meta.valor}`)
          lines.push(`[FICHA DO PRECO — ${fields.join(' | ')}]`)
        }
        // SEMPRE anexa o metadata bruto resumido — mesmo quando a FICHA
        // já foi extraída — pra a IA ter visibilidade completa e poder
        // decidir caso a FICHA tenha pulado algum campo. Sem filtro de
        // noise: prefiro a IA descartar campo irrelevante a perder info
        // crítica (já vimos casos onde tipo/nivel só aparece em key
        // exótica que o filtro removia).
        let rawDump = null
        try {
          const compact = JSON.stringify(d?.metadata ?? null)
          if (compact && compact !== 'null' && compact !== '{}') {
            rawDump = compact.length > 500 ? compact.slice(0, 497) + '...' : compact
          }
        } catch { /* ignore */ }
        // Log do metadata real — aparece no console do servidor ao
        // executar buscar_precos. Indispensável pra ajustar o extrator
        // se o formato real for diferente do canônico.
        try {
          const sample = JSON.stringify(d?.metadata ?? null).slice(0, 800)
          console.log(`[tool/buscar_precos] sample content="${(d?.content || '').slice(0, 80)}" metadata=${sample}`)
        } catch { /* ignore */ }
        if (rawDump) lines.push(`[METADATA BRUTO — ${rawDump}]`)
        if (lines.length === 1) return base // nada extra extraído
        return lines.join('\n\n')
      }
      return base
    })
    .join('\n\n---\n\n')
}

function formatInscricaoResult(data) {
  if (!data.ok) {
    if (data.code === 'CURSO_INVALIDO') {
      return [
        data.message || 'Curso inválido.',
        'INSTRUÇÃO: peça ao usuário o nome completo do curso antes de tentar de novo. Não tente chamar a tool com a string atual.',
      ].join('\n')
    }
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'KOMMO_LEAD_NOT_FOUND' && data.message) return data.message
    if (data.code === 'MISSING_PARAMS') return data.error || 'Informe curso e tipo de ingresso.'
    // Falhas técnicas: não exposor detalhes ao usuário.
    return [
      'Não foi possível concluir a inscrição agora.',
      'INSTRUÇÃO: peça desculpas ao usuário, diga que vai encaminhar para um consultor e siga conversando normalmente. Não cite IDs ou detalhes técnicos.',
    ].join('\n')
  }
  const lines = [
    data.retorno || 'Lead movido para Aguardando Inscrição.',
    `Curso: ${data.curso}`,
    `Tipo de ingresso: ${data.tipo_ingresso}`,
    'INSTRUÇÃO: confirme ao usuário que o pedido de inscrição foi registrado e que um consultor entrará em contato para finalizar. Tom acolhedor e direto.',
  ]
  return lines.join('\n')
}

function formatDistribuirResult(data) {
  if (!data.ok) {
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'KOMMO_LEAD_NOT_FOUND' && data.message) return data.message
    // Em qualquer outro erro, o LLM recebe uma mensagem GENÉRICA com
    // instrução clara — nunca expor pipeline/funil/IDs internos pro
    // cliente. Falhas técnicas viram "consultor entrará em contato em
    // breve" do ponto de vista do usuário.
    if (data.code === 'LEAD_NOT_ELIGIBLE') {
      return [
        'Não foi possível encaminhar para um consultor humano agora.',
        'INSTRUÇÃO: continue ajudando o cliente normalmente e diga que um consultor entrará em contato em breve. Não cite funil, pipeline ou detalhes técnicos.',
      ].join('\n')
    }
    if (data.code === 'DIST_COMERCIAL_NOT_CONFIGURED') {
      return [
        'Distribuição indisponível por configuração interna.',
        'INSTRUÇÃO: peça desculpas brevemente e diga que um consultor entrará em contato em breve.',
      ].join('\n')
    }
    return [
      'Distribuição não executada.',
      'INSTRUÇÃO: continue a conversa normalmente e diga que um consultor entrará em contato em breve. Não cite detalhes técnicos.',
    ].join('\n')
  }
  const lines = [
    data.retorno || 'Distribuição concluída.',
    data.consultor ? `Consultor designado: ${data.consultor}` : null,
  ].filter(Boolean)
  if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
  // Sem `id_consultor` pra o LLM — não traz valor pro cliente final.
  return lines.join('\n')
}

function formatLocationResult(data) {
  if (!data.ok) return `Não foi possível encontrar o polo: ${data.error || 'erro'}`
  // Localização vaga (ex.: "Zona Leste", "centro", só cidade): não devolve
  // tempo/distância — eles seriam calculados de um ponto arbitrário e
  // podem enganar o cliente. Em vez disso, mandamos uma INSTRUÇÃO
  // explícita pra o orquestrador pedir endereço/CEP antes de prometer
  // qualquer coisa.
  if (data.imprecise) {
    const polo = data.polo_provavel || 'Polo'
    const endereco = data.rua_do_polo ? `\nEndereço do polo: ${data.rua_do_polo}` : ''
    return [
      'ATENÇÃO — LOCALIZAÇÃO IMPRECISA:',
      `A localização informada${data.origem_imprecisa ? ` ("${data.origem_imprecisa}")` : ''} é uma área genérica, não um endereço exato. NÃO É POSSÍVEL calcular tempo nem distância confiáveis.`,
      '',
      `Polo provável dessa região: ${polo}${endereco}`,
      '',
      'INSTRUÇÃO PARA O ATENDIMENTO:',
      '1. PEÇA ao cliente o endereço completo (rua e número) ou o CEP antes de informar tempo/rota.',
      '2. Caso o cliente prefira NÃO informar, pode mencionar APENAS o nome do polo provável acima — NUNCA cite tempo ou distância para uma localização imprecisa.',
      '3. Não invente tempo, distância ou link de rota.',
    ].join('\n')
  }
  return [
    `Polo mais próximo: ${data.polo_mais_proximo}`,
    `Endereço do polo: ${data.rua_do_polo}`,
    `Tempo estimado (${data.modo_transporte}): ${data.tempo_estimado}`,
    data.distancia ? `Distância: ${data.distancia}` : null,
    `Link da rota no Google Maps: ${data.link_rota_google}`,
    data.origem_endereco ? `Endereço reconhecido: ${data.origem_endereco}` : null,
    '',
    'INSTRUÇÃO PARA A RESPOSTA AO CLIENTE:',
    `Inclua SEMPRE o link da rota acima (${data.link_rota_google}) na sua resposta — é assim que o cliente abre o trajeto no app de mapas. Nunca omita o link quando ele estiver disponível.`,
  ].filter(Boolean).join('\n')
}

/**
 * Empurra os usages do `_meta` retornado por uma tool dentro do `ctx`.
 * Hoje só `inscricao` e `distribuir_humano` retornam `_meta`.
 */
function absorbToolMeta(ctx, raw) {
  if (!ctx || !raw || typeof raw !== 'object' || !raw._meta) return
  const meta = raw._meta
  if (Array.isArray(meta.toolUsage)) {
    for (const u of meta.toolUsage) ctx.recordToolUsage(u)
  }
  if (Array.isArray(meta.queryRewriteUsage)) {
    for (const u of meta.queryRewriteUsage) ctx.recordQueryRewriteUsage(u)
  }
  if (Array.isArray(meta.embeddingsUsage)) {
    for (const u of meta.embeddingsUsage) ctx.recordEmbeddingsUsage(u)
  }
}

/**
 * @param {Record<string,string>} env
 * @param {ReturnType<typeof import('./executionContext.js').createExecutionContext>} [ctx]
 *   Opcional. Quando passado, sub-usages (query rewrite, embeddings,
 *   resumos de tools) são acumulados pra dashboard. Sem ctx, vira no-op.
 */
export function buildToolExecutors(env, ctx) {
  const safeCtx = ctx || createNoopExecutionContext()
  return {
    buscar_precos: async ({ query, nivel }) =>
      vectorSearch(env, safeCtx, 'buscar_precos', 'match_documents_precos', query, 8, { nivel }),
    buscar_informacoes: async ({ query }) =>
      vectorSearch(env, safeCtx, 'buscar_informacoes', 'match_documents', query, 15),
    buscar_pos: async ({ query }) =>
      vectorSearch(env, safeCtx, 'buscar_pos', 'match_documents_pos', query, 8),
    buscar_perguntas: async ({ query }) => {
      const out = await vectorSearch(env, safeCtx, 'buscar_perguntas', 'match_documents_perguntas', query, 6)
      // Quando o RAG não acha nada, dá pra IA uma instrução explícita
      // pra DISTRIBUIR pra humano em vez de inventar resposta sobre
      // processos internos da empresa (matrícula, dispensa, etc.).
      if (out === 'Nenhum resultado encontrado na base.') {
        return [
          'Nenhum resultado encontrado na base de FAQ para esta pergunta.',
          '',
          'INSTRUÇÃO OBRIGATÓRIA: NÃO invente resposta sobre processos da empresa. NÃO mande o cliente "procurar a faculdade", "ligar para a coordenação", "consultar a secretaria", "verificar com o polo". Quem analisa esse tipo de caso somos NÓS.',
          'Em vez disso, chame a tool distribuir_humano (passando o telefone do Contexto) e responda ao cliente que um consultor entrará em contato em breve para ajudar.',
        ].join('\n')
      }
      return out
    },
    localizacao: async (args) => formatLocationResult(await runNearestPolo(env, args)),
    inscricao: async (args) => {
      const r = await runInscricao(env, args)
      absorbToolMeta(safeCtx, r)
      return formatInscricaoResult(r)
    },
    distribuir_humano: async (args) => {
      const r = await runDistribuirHumano(env, args)
      absorbToolMeta(safeCtx, r)
      return formatDistribuirResult(r)
    },
    buscar_historico_conversa: async (args) => {
      const out = await runBuscarHistorico(env, args)
      if (!out.ok) return `Não foi possível recuperar o histórico: ${out.error || 'erro'}`
      return out.historico || 'Sem histórico de conversa disponível.'
    },
  }
}
