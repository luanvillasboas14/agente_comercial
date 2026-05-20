import { rewriteSearchQuery } from './queryRewrite'

const BASE_URL = '/api/supabase'
const EMBEDDING_MODEL = 'text-embedding-3-small'

async function getEmbedding(text, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: text,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Embedding HTTP ${res.status}`)
  }
  const data = await res.json()
  return {
    embedding: data.data[0].embedding,
    usage: data.usage || null,
    model: EMBEDDING_MODEL,
  }
}

/**
 * Busca vetorial no Supabase. Espelha `server/ai/toolExecutorsServer.vectorSearch`:
 *   1. (opcional) reescreve a query com `gpt-4.1-nano`.
 *   2. gera embedding (`text-embedding-3-small`) da query final.
 *   3. chama o RPC `match_documents_*`.
 *
 * `traceCollector` (opcional) recebe metadados pra a aba "Execuções"
 * mostrar o que a reescrita fez e pra o Playground contabilizar custo
 * de tudo no `aiMeta`:
 *   {
 *     queryRewrite: { applied, query, originalQuery, model, usage, reason, elapsedMs },
 *     embeddingsUsage: { model, usage },
 *   }
 */
async function vectorSearch(rpcName, query, apiKey, matchCount = 10, opts = {}) {
  const traceCollector = opts.traceCollector || null
  const toolName = opts.toolName || rpcName

  // Etapa 1 — reescrita conservadora (com fallback p/ a query original).
  const rw = await rewriteSearchQuery({
    rawQuery: query,
    toolName,
    apiKey,
    model: opts.rewriteModel || 'gpt-4.1-nano',
    enabled: opts.rewriteEnabled !== false,
  })
  if (traceCollector) traceCollector.queryRewrite = rw
  const finalQuery = rw.applied ? rw.query : query
  if (rw.applied) {
    console.log(`[Supabase] queryRewrite: "${query}" → "${finalQuery}"`)
  } else if (rw.reason && rw.reason !== 'disabled' && rw.reason !== 'noop') {
    console.log(`[Supabase] queryRewrite skip: ${rw.reason}`)
  }

  console.log(`[Supabase] Gerando embedding para: "${finalQuery}"`)
  const emb = await getEmbedding(finalQuery, apiKey)
  if (traceCollector && emb.usage) {
    traceCollector.embeddingsUsage = { model: emb.model, usage: emb.usage }
  }
  console.log(`[Supabase] Embedding OK (${emb.embedding.length} dims), chamando RPC ${rpcName}...`)

  const url = `${BASE_URL}/rest/v1/rpc/${rpcName}`
  console.log(`[Supabase] POST ${url}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query_embedding: emb.embedding,
      filter: {},
      match_count: matchCount,
    }),
  })

  if (!res.ok) {
    const errBody = await res.text().catch(() => '')
    console.error(`[Supabase] ERRO ${res.status}:`, errBody)
    throw new Error(`Supabase ${res.status}: ${errBody.substring(0, 200)}`)
  }

  const data = await res.json()
  console.log(`[Supabase] ${rpcName} retornou ${data.length} resultados`)

  if (!Array.isArray(data) || data.length === 0) {
    return 'Nenhum resultado encontrado na base.'
  }
  return data.map((d) => d.content).join('\n\n---\n\n')
}

export async function buscarPrecos(query, apiKey, traceCollector) {
  return vectorSearch('match_documents_precos', query, apiKey, 8, { traceCollector, toolName: 'buscar_precos' })
}

export async function buscarInformacoes(query, apiKey, traceCollector) {
  return vectorSearch('match_documents', query, apiKey, 15, { traceCollector, toolName: 'buscar_informacoes' })
}

export async function buscarPos(query, apiKey, traceCollector) {
  return vectorSearch('match_documents_pos', query, apiKey, 8, { traceCollector, toolName: 'buscar_pos' })
}

export async function buscarPerguntas(query, apiKey, traceCollector) {
  return vectorSearch('match_documents_perguntas', query, apiKey, 6, { traceCollector, toolName: 'buscar_perguntas' })
}

/** Tool localização — chama API do servidor (Google Geocoding + Supabase polo_loc + Distance Matrix). */
export async function executarLocalizacao(args) {
  const res = await fetch('/api/location/nearest-polo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      localizacao: args.localizacao,
      telefone: args.telefone,
    }),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Resposta inválida da API de localização')
  }
  if (!data.ok) {
    return `Não foi possível encontrar o polo mais próximo: ${data.error || `HTTP ${res.status}`}`
  }
  // Localização vaga: não mostrar tempo nem distância — apenas o
  // polo provável + instrução pra o LLM pedir endereço/CEP.
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
  const lines = [
    `Polo mais próximo: ${data.polo_mais_proximo}`,
    `Endereço do polo: ${data.rua_do_polo}`,
    `Tempo estimado (${data.modo_transporte}): ${data.tempo_estimado}`,
    data.distancia ? `Distância aproximada: ${data.distancia}` : null,
    `Link da rota no Google Maps: ${data.link_rota_google}`,
    data.origem_endereco ? `Endereço reconhecido do lead: ${data.origem_endereco}` : null,
    '',
    'INSTRUÇÃO PARA A RESPOSTA AO CLIENTE:',
    `Inclua SEMPRE o link da rota acima (${data.link_rota_google}) na sua resposta — é assim que o cliente abre o trajeto no app de mapas. Nunca omita o link quando ele estiver disponível.`,
  ].filter(Boolean)
  return lines.join('\n')
}

/** Tool inscrição — Kommo + Supabase + resumo (servidor). telefone/id_lead opcionais até integração CRM. */
export async function executarInscricao(args) {
  const body = {
    curso: args.curso ?? args.Curso,
    tipo_ingresso: args.tipo_ingresso ?? args.tipoIngresso ?? args['Tipo de ingresso'],
    telefone: args.telefone,
    id_lead: args.id_lead ?? args.idLead,
  }
  const res = await fetch('/api/inscricao/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Resposta inválida da API de inscrição')
  }
  if (data.ok) {
    const lines = [
      data.retorno || 'Inscrição processada.',
      `Curso: ${data.curso}`,
      `Tipo de ingresso: ${data.tipo_ingresso}`,
    ]
    if (data.destino === 'aguardando_inscricao') lines.push('Destino no CRM: Aguardando Inscrição.')
    if (data.destino === 'atendimento') lines.push('Destino no CRM: atendimento (consultor).')
    if (data.missing_fields?.length) {
      lines.push(`Pendências na nota: ${data.missing_fields.join(', ')}`)
    }
    if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
    if (data.warnings?.length) lines.push(`Avisos: ${data.warnings.join(' | ')}`)
    return lines.join('\n')
  }
  if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
  if (data.code === 'MISSING_PARAMS') return data.error || 'Informe curso e tipo de ingresso (ENEM ou Vestibular Múltipla Escolha).'
  return `Inscrição não executada: ${data.error || data.message || data.code || `HTTP ${res.status}`}`
}

/** Tool memória — histórico da conversa em n8n_chat_histories (Supabase principal). */
export async function executarBuscarHistorico(args) {
  const res = await fetch('/api/memory/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      telefone: args.telefone,
      limit: args.limit,
    }),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Resposta inválida da API de memória')
  }
  if (!data.ok) {
    if (data.code === 'MISSING_PARAMS') return data.error || 'Informe o telefone do lead para buscar o histórico.'
    return `Não foi possível recuperar o histórico: ${data.error || `HTTP ${res.status}`}`
  }
  return data.historico || 'Sem histórico de conversa disponível.'
}

/** Tool distribuir_humano — fila de consultor (Kommo + distrib_comercial + resumo). */
export async function executarDistribuirHumano(args) {
  const res = await fetch('/api/distribuir-humano/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id_lead: args.id_lead ?? args.idLead,
      telefone: args.telefone,
    }),
  })
  let data
  try {
    data = await res.json()
  } catch {
    throw new Error('Resposta inválida da API de distribuição')
  }
  if (data.ok) {
    const lines = [
      data.retorno || 'Distribuição concluída.',
      data.consultor ? `Consultor designado: ${data.consultor}` : null,
    ].filter(Boolean)
    if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
    return lines.join('\n')
  }
  if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
  // Erros técnicos viram instrução genérica pro LLM — nunca expor
  // funil/pipeline/IDs internos pro cliente.
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

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'buscar_precos',
      description: 'Busca preços e valores de cursos. SEMPRE passe o parâmetro `nivel` quando souber pelo contexto da conversa se o lead quer graduação ou pós — assim a tool já filtra e você não recebe resultados do nível errado.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nome limpo do curso (ex: "Administração").',
          },
          nivel: {
            type: 'string',
            enum: ['graduacao', 'pos'],
            description: 'Nível do curso. Use "graduacao" pra cursos de graduação (bacharelado, licenciatura, tecnólogo). Use "pos" pra pós-graduação, MBA ou especialização. OMITA APENAS se o contexto for genuinamente ambíguo — quando souber pelo histórico da conversa, passe sempre.',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_informacoes',
      description: 'Busca informações de cursos de GRADUAÇÃO na base vetorial (grade curricular, duração, modalidades, áreas de atuação). NÃO use para pós-graduação.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nome limpo do curso de graduação (ex: "Psicologia", "Administração")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_pos',
      description: 'Busca informações de cursos de PÓS-GRADUAÇÃO, MBA e especializações na base vetorial. Use SOMENTE quando o usuário mencionar pós, MBA ou especialização.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nome limpo do curso de pós-graduação (ex: "Marketing Digital", "Gestão de Pessoas")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_perguntas',
      description: 'Busca respostas para perguntas frequentes (FAQ) na base vetorial. Use para dúvidas sobre matrícula, documentos, funcionamento, bolsas, processos, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A pergunta do usuário (ex: "como funciona o semipresencial", "documentos para matrícula")',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'localizacao',
      description:
        'Encontra o polo da Cruzeiro do Sul mais próximo do endereço informado pelo lead. ' +
        'Use quando houver CEP, cidade, bairro, rua com número ou descrição de local. ' +
        'Chame com o texto completo de localização que o usuário passou (ex.: "São Paulo, Av. Paulista, 1000" ou "01310-100").',
      parameters: {
        type: 'object',
        properties: {
          localizacao: {
            type: 'string',
            description: 'Cidade, rua e número ou CEP (texto livre para geocodificação)',
          },
          telefone: {
            type: 'string',
            description: 'Telefone do lead (opcional; reservado para rastreio)',
          },
        },
        required: ['localizacao'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'inscricao',
      description:
        'Dispara o fluxo de inscrição: move o lead para "Aguardando Inscrição" no Kommo e preenche curso, tipo de ingresso, nível, nome e polo. ' +
        'Use quando o lead confirmar que quer se inscrever em um curso específico (depois de já ter o nome completo do curso — NUNCA chame com curso vago como "as", "ola" ou abreviações). ' +
        'O telefone do lead está no Contexto do atendimento — sempre passe ele. ' +
        'O id_lead é OPCIONAL: se não souber, OMITA o campo (a tool resolve pelo telefone). Nunca envie 0.',
      parameters: {
        type: 'object',
        properties: {
          curso: {
            type: 'string',
            description: 'Nome completo do curso confirmado pelo lead (ex.: "Desenvolvimento Backend").',
          },
          tipo_ingresso: {
            type: 'string',
            enum: ['ENEM', 'Vestibular Múltipla Escolha'],
            description: 'Prova de ingresso: ENEM ou Vestibular Múltipla Escolha.',
          },
          telefone: {
            type: 'string',
            description: 'Telefone do lead (Contexto do atendimento).',
          },
          id_lead: {
            type: 'integer',
            description: 'OPCIONAL — id_lead do Kommo se já estiver no Contexto. OMITA se não souber.',
          },
        },
        required: ['curso', 'tipo_ingresso', 'telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'buscar_historico_conversa',
      description:
        'Recupera o histórico recente de conversa com o lead no WhatsApp (memória do agente, tabela n8n_chat_histories). ' +
        'Use SEMPRE que o telefone do lead estiver disponível no contexto e você ainda não conhecer a conversa anterior — ' +
        'chame UMA vez no início do turno para entender o que já foi tratado antes de responder. ' +
        'A chave (session_id) é o telefone em dígitos + "@s.whatsapp.net" e é montada automaticamente a partir do parâmetro telefone.',
      parameters: {
        type: 'object',
        properties: {
          telefone: {
            type: 'string',
            description: 'Telefone do lead (ex.: "5511998209798") ou o session_id completo (ex.: "5511998209798@s.whatsapp.net").',
          },
          limit: {
            type: 'integer',
            description: 'Quantas mensagens recuperar (padrão 20, máx 100). Use 8–20 para entender o contexto recente.',
          },
        },
        required: ['telefone'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'distribuir_humano',
      description:
        'Encaminha o lead para um consultor humano. Use quando o cliente PEDIR para falar com atendente/consultor/humano, ' +
        'ou quando a conversa indicar que ele precisa de ajuda especializada (negociação, casos complexos, fora do escopo da IA). ' +
        '⚠️ Não use se o cliente apenas perguntou preço/curso e há dados pra responder — primeiro venda, depois encaminhe se ele insistir. ' +
        'O sistema localiza o lead pelo telefone automaticamente — você NÃO precisa passar id_lead se não souber.',
      parameters: {
        type: 'object',
        properties: {
          telefone: {
            type: 'string',
            description: 'Telefone/WhatsApp do lead (obrigatório). Pode ser só dígitos ou com +55.',
          },
          id_lead: {
            type: 'integer',
            description: 'ID do lead no Kommo. OPCIONAL — se você não souber, omita este campo (NÃO mande 0 nem inventado).',
          },
        },
        required: ['telefone'],
      },
    },
  },
]

export const TOOL_EXECUTORS = {
  buscar_precos: (args, apiKey, traceCollector) => buscarPrecos(args.query, apiKey, traceCollector),
  buscar_informacoes: (args, apiKey, traceCollector) => buscarInformacoes(args.query, apiKey, traceCollector),
  buscar_pos: (args, apiKey, traceCollector) => buscarPos(args.query, apiKey, traceCollector),
  buscar_perguntas: (args, apiKey, traceCollector) => buscarPerguntas(args.query, apiKey, traceCollector),
  localizacao: (args) => executarLocalizacao(args),
  inscricao: (args) => executarInscricao(args),
  distribuir_humano: (args) => executarDistribuirHumano(args),
  buscar_historico_conversa: (args) => executarBuscarHistorico(args),
}
