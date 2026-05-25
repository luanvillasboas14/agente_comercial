import { listActiveExamples } from './examplesStore.js'

let currentExamples = []
let lastRefreshMs = 0

const REFRESH_INTERVAL_MS = 60_000

export async function refreshExamples(env) {
  if (Date.now() - lastRefreshMs < REFRESH_INTERVAL_MS) return
  try {
    const examples = await listActiveExamples(env)
    currentExamples = Array.isArray(examples) ? examples : []
    lastRefreshMs = Date.now()
    console.log(`[IaLearning/fewshot] cache atualizado: ${currentExamples.length} exemplos ativos`)
  } catch (e) {
    console.warn(`[IaLearning/fewshot] refresh falhou: ${e.message}`)
  }
}

export function getActiveExamplesFromCache() {
  return currentExamples
}

/**
 * Retorna bloco de texto formatado pra injetar no system prompt.
 * Pega K exemplos aleatórios respeitando token cap.
 * Se desabilitado via env (IA_LEARNING_FEWSHOT_ENABLED=false), retorna ''.
 */
export function buildFewShotBlock(env) {
  if (String(env.IA_LEARNING_FEWSHOT_ENABLED || 'true').toLowerCase() === 'false') return ''
  if (currentExamples.length === 0) return ''

  const k = Math.max(1, Math.min(10, Number(env.IA_LEARNING_FEWSHOT_K || 5)))
  const maxTokens = Math.max(200, Math.min(3000, Number(env.IA_LEARNING_FEWSHOT_MAX_TOKENS || 1200)))

  // Shuffle e pega K
  const shuffled = [...currentExamples].sort(() => Math.random() - 0.5).slice(0, k)

  const parts = ['## EXEMPLOS DE BOAS RESPOSTAS DOS CONSULTORES (use como referência de tom e estilo)', '']
  let estimatedTokens = 30
  for (const ex of shuffled) {
    const block = formatExample(ex)
    const blockTokens = Math.ceil(block.length / 4) // estimativa grosseira
    if (estimatedTokens + blockTokens > maxTokens) break
    parts.push(block)
    parts.push('')
    estimatedTokens += blockTokens
  }
  return parts.join('\n')
}

function formatExample(ex) {
  const lines = []
  lines.push(`### Exemplo (${ex.categoria}) — ${ex.contexto_resumido || ''}`)
  for (const msg of (Array.isArray(ex.dialogo) ? ex.dialogo : [])) {
    const tag = msg.remetente === 'lead' ? 'LEAD' : 'CONSULTOR'
    lines.push(`${tag}: ${String(msg.texto || '').trim()}`)
  }
  return lines.join('\n')
}
