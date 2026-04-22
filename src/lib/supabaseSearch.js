const BASE_URL = '/api/supabase'

async function getEmbedding(text, apiKey) {
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.error?.message || `Embedding HTTP ${res.status}`)
  }
  const data = await res.json()
  return data.data[0].embedding
}

async function vectorSearch(rpcName, query, apiKey, matchCount = 10) {
  console.log(`[Supabase] Gerando embedding para: "${query}"`)
  const embedding = await getEmbedding(query, apiKey)
  console.log(`[Supabase] Embedding OK (${embedding.length} dims), chamando RPC ${rpcName}...`)

  const url = `${BASE_URL}/rest/v1/rpc/${rpcName}`
  console.log(`[Supabase] POST ${url}`)

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query_embedding: embedding,
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

export async function buscarPrecos(query, apiKey) {
  return vectorSearch('match_documents_precos', query, apiKey, 8)
}

export async function buscarInformacoes(query, apiKey) {
  return vectorSearch('match_documents', query, apiKey, 15)
}

export async function buscarPos(query, apiKey) {
  return vectorSearch('match_documents_pos', query, apiKey, 8)
}

export async function buscarPerguntas(query, apiKey) {
  return vectorSearch('match_documents_perguntas', query, apiKey, 6)
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
  const lines = [
    `Polo mais próximo: ${data.polo_mais_proximo}`,
    `Endereço do polo: ${data.rua_do_polo}`,
    `Tempo estimado (${data.modo_transporte}): ${data.tempo_estimado}`,
    data.distancia ? `Distância aproximada: ${data.distancia}` : null,
    `Link da rota no Google Maps: ${data.link_rota_google}`,
    data.origem_endereco ? `Endereço reconhecido do lead: ${data.origem_endereco}` : null,
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
      data.consultor ? `Consultor: ${data.consultor}` : null,
      data.id_consultor != null ? `ID consultor (Kommo): ${data.id_consultor}` : null,
    ].filter(Boolean)
    if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
    if (data.warnings?.length) lines.push(`Avisos: ${data.warnings.join(' | ')}`)
    return lines.join('\n')
  }
  if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
  if (data.code === 'LEAD_NOT_ELIGIBLE' && data.message) return data.message
  if (data.code === 'DIST_COMERCIAL_NOT_CONFIGURED') return data.error
  return `Distribuição não executada: ${data.error || data.message || data.code || `HTTP ${res.status}`}`
}

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'buscar_precos',
      description: 'Busca preços e valores de cursos na base vetorial do Supabase. Use quando precisar de informações sobre mensalidades, valores e preços de cursos.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Nome limpo do curso para buscar preços (ex: "Administração", "Psicologia", "Recursos Humanos")',
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
        'Dispara o fluxo de inscrição no WhatsApp (template e integração Kommo/Supabase), com curso e tipo de ingresso. ' +
        'Use quando o interessado confirmar inscrição ou pedir para seguir com a matrícula/inscrição. ' +
        'Tipo de ingresso: ENEM ou Vestibular Múltipla Escolha. ' +
        'telefone e id_lead são opcionais no playground até a integração com o CRM; sem eles o servidor retorna aviso de integração pendente.',
      parameters: {
        type: 'object',
        properties: {
          curso: {
            type: 'string',
            description: 'Nome do curso desejado pelo interessado.',
          },
          tipo_ingresso: {
            type: 'string',
            enum: ['ENEM', 'Vestibular Múltipla Escolha'],
            description: 'Prova de ingresso: ENEM ou Vestibular Múltipla Escolha.',
          },
          telefone: {
            type: 'string',
            description: 'Telefone do lead (WhatsApp); opcional até integração.',
          },
          id_lead: {
            type: 'integer',
            description: 'ID do lead no Kommo; opcional até integração.',
          },
        },
        required: ['curso', 'tipo_ingresso'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'distribuir_humano',
      description:
        '⚠️ SÓ USAR SE o contexto/RAG indicar distribuir_humano ou ausência de resultado de curso (RAG_SEM_RESULTADO). ' +
        '❌ NUNCA usar se houver dados de curso para vender (preço, grade, etc.): quando tem dados = vender, não distribuir. ' +
        'Encaminha o lead para um consultor humano: exige id_lead e telefone no CRM; o lead deve estar nas etapas corretas do funil de distribuição.',
      parameters: {
        type: 'object',
        properties: {
          id_lead: {
            type: 'integer',
            description: 'ID do lead no Kommo.',
          },
          telefone: {
            type: 'string',
            description: 'Telefone/WhatsApp do lead (mesmo formato usado no CRM ou chat).',
          },
        },
        required: ['id_lead', 'telefone'],
      },
    },
  },
]

export const TOOL_EXECUTORS = {
  buscar_precos: (args, apiKey) => buscarPrecos(args.query, apiKey),
  buscar_informacoes: (args, apiKey) => buscarInformacoes(args.query, apiKey),
  buscar_pos: (args, apiKey) => buscarPos(args.query, apiKey),
  buscar_perguntas: (args, apiKey) => buscarPerguntas(args.query, apiKey),
  localizacao: (args) => executarLocalizacao(args),
  inscricao: (args) => executarInscricao(args),
  distribuir_humano: (args) => executarDistribuirHumano(args),
}
