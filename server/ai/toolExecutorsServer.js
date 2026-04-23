/**
 * Executores das tools no lado servidor — chamam direto os módulos locais
 * (sem HTTP). Use em conjunto com TOOL_DEFINITIONS.
 */

import { runNearestPolo } from '../locationTool.js'
import { runInscricao } from '../inscricaoTool.js'
import { runDistribuirHumano } from '../distribuirHumanoTool.js'
import { runBuscarHistorico } from '../memoryTool.js'

async function getEmbedding(env, text) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Embedding ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  return data.data[0].embedding
}

async function vectorSearch(env, rpcName, query, matchCount = 10) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!url || !key) return 'Supabase não configurado no servidor.'
  const embedding = await getEmbedding(env, query)
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
  return data.map((d) => d.content).join('\n\n---\n\n')
}

function formatInscricaoResult(data) {
  if (!data.ok) {
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'MISSING_PARAMS') return data.error || 'Informe curso e tipo de ingresso.'
    return `Inscrição não executada: ${data.error || data.message || data.code || 'erro'}`
  }
  const lines = [data.retorno || 'Inscrição processada.', `Curso: ${data.curso}`, `Tipo de ingresso: ${data.tipo_ingresso}`]
  if (data.destino === 'aguardando_inscricao') lines.push('Destino no CRM: Aguardando Inscrição.')
  if (data.destino === 'atendimento') lines.push('Destino no CRM: atendimento (consultor).')
  if (data.missing_fields?.length) lines.push(`Pendências: ${data.missing_fields.join(', ')}`)
  if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
  if (data.warnings?.length) lines.push(`Avisos: ${data.warnings.join(' | ')}`)
  return lines.join('\n')
}

function formatDistribuirResult(data) {
  if (!data.ok) {
    if (data.code === 'MISSING_CRM_FIELDS' && data.message) return data.message
    if (data.code === 'LEAD_NOT_ELIGIBLE' && data.message) return data.message
    if (data.code === 'DIST_COMERCIAL_NOT_CONFIGURED') return data.error
    return `Distribuição não executada: ${data.error || data.message || data.code || 'erro'}`
  }
  const lines = [
    data.retorno || 'Distribuição concluída.',
    data.consultor ? `Consultor: ${data.consultor}` : null,
    data.id_consultor != null ? `ID consultor (Kommo): ${data.id_consultor}` : null,
  ].filter(Boolean)
  if (data.resumo_campos?.resumo) lines.push(`Resumo: ${data.resumo_campos.resumo}`)
  if (data.warnings?.length) lines.push(`Avisos: ${data.warnings.join(' | ')}`)
  return lines.join('\n')
}

function formatLocationResult(data) {
  if (!data.ok) return `Não foi possível encontrar o polo: ${data.error || 'erro'}`
  return [
    `Polo mais próximo: ${data.polo_mais_proximo}`,
    `Endereço do polo: ${data.rua_do_polo}`,
    `Tempo estimado (${data.modo_transporte}): ${data.tempo_estimado}`,
    data.distancia ? `Distância: ${data.distancia}` : null,
    `Rota: ${data.link_rota_google}`,
    data.origem_endereco ? `Endereço reconhecido: ${data.origem_endereco}` : null,
  ].filter(Boolean).join('\n')
}

export function buildToolExecutors(env) {
  return {
    buscar_precos: async ({ query }) => vectorSearch(env, 'match_documents_precos', query, 8),
    buscar_informacoes: async ({ query }) => vectorSearch(env, 'match_documents', query, 15),
    buscar_pos: async ({ query }) => vectorSearch(env, 'match_documents_pos', query, 8),
    buscar_perguntas: async ({ query }) => vectorSearch(env, 'match_documents_perguntas', query, 6),
    localizacao: async (args) => formatLocationResult(await runNearestPolo(env, args)),
    inscricao: async (args) => formatInscricaoResult(await runInscricao(env, args)),
    distribuir_humano: async (args) => formatDistribuirResult(await runDistribuirHumano(env, args)),
    buscar_historico_conversa: async (args) => {
      const out = await runBuscarHistorico(env, args)
      if (!out.ok) return `Não foi possível recuperar o histórico: ${out.error || 'erro'}`
      return out.historico || 'Sem histórico de conversa disponível.'
    },
  }
}
