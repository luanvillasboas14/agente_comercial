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
]

export const TOOL_EXECUTORS = {
  buscar_precos: (args, apiKey) => buscarPrecos(args.query, apiKey),
  buscar_informacoes: (args, apiKey) => buscarInformacoes(args.query, apiKey),
  buscar_pos: (args, apiKey) => buscarPos(args.query, apiKey),
  buscar_perguntas: (args, apiKey) => buscarPerguntas(args.query, apiKey),
}
