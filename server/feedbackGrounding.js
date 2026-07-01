/**
 * Grounding do Feedback Comercial — dá ao avaliador uma "fonte de verdade"
 * pra detectar informação divulgada de forma ERRADA pelo consultor.
 *
 * Usa a MESMA base de conhecimento (RAG) do agente, no Supabase PRINCIPAL
 * (SUPABASE_URL/SUPABASE_KEY):
 *   - match_documents           (graduação)
 *   - match_documents_pos       (pós-graduação)
 *   - match_documents_perguntas (FAQ)
 *
 * IMPORTANTE: NÃO usamos a base de PREÇOS (match_documents_precos) e ainda
 * redigimos qualquer menção a valor/preço do conteúdo — os preços da base
 * divergem dos praticados, então não servem como gabarito (decisão do usuário).
 *
 * O bloco retornado é injetado no prompt de avaliação. O avaliador só marca
 * "informação errada" quando o que o consultor disse CONTRADIZ este bloco;
 * se a base não cobre o assunto, não penaliza (não dá pra verificar).
 */

import { resolveModel } from './ai/modelRegistry.js'

/** Redige menções a preço/valor pra não usar preço como gabarito. */
function stripPrices(text) {
  if (!text) return ''
  // Quebra em segmentos (campos separados por ; ou nova linha) e descarta os
  // que falam de preço; no restante, remove tokens "R$ ...".
  const PRICE_SEG = /(pre[çc]o|valor|mensalidade|parcela|investimento|desconto|bolsa\s*de|R\$)/i
  return String(text)
    .split(/[\n;]+/)
    .filter((seg) => !PRICE_SEG.test(seg))
    .join('; ')
    .replace(/R\$\s*[\d.,]+/gi, '[preço omitido]')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

async function getEmbedding(env, text) {
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
  return data?.data?.[0]?.embedding || null
}

async function rpcMatch(url, key, rpcName, embedding, matchCount) {
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
    throw new Error(`RPC ${rpcName} ${res.status}: ${body.slice(0, 160)}`)
  }
  const data = await res.json()
  return Array.isArray(data) ? data : []
}

/**
 * Monta o bloco de conhecimento oficial pra uma conversa.
 *
 * @returns {Promise<{ block: string|null, sources: number, error?: string }>}
 */
export async function fetchKnowledgeGrounding(env, conversationText, opts = {}) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY
  if (!url || !key) return { block: null, sources: 0, error: 'SUPABASE principal não configurado' }

  const query = String(conversationText || '').trim().slice(0, 2500)
  if (!query) return { block: null, sources: 0 }

  const maxChars = Number(opts.maxChars) > 0 ? Number(opts.maxChars) : 4000
  const perDocChars = Number(opts.perDocChars) > 0 ? Number(opts.perDocChars) : 600

  let embedding
  try {
    embedding = await getEmbedding(env, query)
  } catch (e) {
    return { block: null, sources: 0, error: e.message }
  }
  if (!embedding) return { block: null, sources: 0, error: 'embedding vazio' }

  // Uma embedding, três buscas (grad, pós, FAQ). Falha isolada não derruba.
  const tables = [
    { rpc: 'match_documents', k: 6, label: 'GRADUAÇÃO' },
    { rpc: 'match_documents_pos', k: 4, label: 'PÓS-GRADUAÇÃO' },
    { rpc: 'match_documents_perguntas', k: 4, label: 'FAQ' },
  ]
  const results = await Promise.allSettled(
    tables.map((t) => rpcMatch(url, key, t.rpc, embedding, t.k)),
  )

  const parts = []
  let total = 0
  let sources = 0
  for (let i = 0; i < tables.length; i++) {
    const r = results[i]
    if (r.status !== 'fulfilled' || !Array.isArray(r.value)) continue
    for (const doc of r.value) {
      const clean = stripPrices(doc?.content || '')
      if (!clean) continue
      const snippet = clean.slice(0, perDocChars)
      const line = `[${tables[i].label}] ${snippet}`
      if (total + line.length > maxChars) break
      parts.push(line)
      total += line.length
      sources++
    }
    if (total >= maxChars) break
  }

  if (sources === 0) return { block: null, sources: 0 }
  return { block: parts.join('\n---\n'), sources }
}
