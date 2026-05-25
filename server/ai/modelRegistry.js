/**
 * Resolução central de modelos OpenAI por "papel" (orchestrator,
 * query_rewrite, inscricao_summary, etc.) com override por tool
 * específica e fallback inteligente.
 *
 * Por que existe:
 *   - Antes, o modelo do orquestrador era hardcoded em `agentRunner.js`
 *     (uma única env). Os modelos auxiliares de tools (resumo de
 *     inscrição, distribuir humano) eram constantes Python-style
 *     hardcoded em cada arquivo. Trocar custava mexer em 4 lugares.
 *   - Agora cada papel tem uma env clara, todos com fallback
 *     consistente, e troca-se um modelo só editando o .env.
 *
 * Hierarquia de fallback (do mais específico ao mais genérico):
 *   1. OPENAI_MODEL_TOOL_<NOME_TOOL_UPPERCASE>     (override por tool)
 *   2. OPENAI_MODEL_<PAPEL_UPPERCASE>              (papel)
 *   3. OPENAI_AGENT_MODEL                          (legado - orquestrador)
 *   4. OPENAI_MODEL                                (legado - global)
 *   5. default do papel (ver DEFAULTS abaixo)
 *
 * Exemplo:
 *   resolveModel(env, 'orchestrator')
 *     → OPENAI_MODEL_ORCHESTRATOR || OPENAI_AGENT_MODEL || OPENAI_MODEL || 'gpt-4.1-mini'
 *
 *   resolveModel(env, 'query_rewrite', { tool: 'buscar_precos' })
 *     → OPENAI_MODEL_TOOL_BUSCAR_PRECOS
 *       || OPENAI_MODEL_QUERY_REWRITE
 *       || OPENAI_AGENT_MODEL || OPENAI_MODEL
 *       || 'gpt-4.1-nano'
 */

/**
 * Defaults por papel. Otimizados para custo baixo + qualidade
 * suficiente. Atualizar aqui quando a OpenAI lançar modelo melhor/
 * mais barato (e atualizar src/lib/openaiPricing.js se for novo).
 */
const DEFAULTS = {
  orchestrator: 'gpt-4.1-mini',          // function calling forte, bom em PT-BR
  query_rewrite: 'gpt-4.1-nano',         // ultra rápido + barato
  inscricao_summary: 'gpt-4.1-mini',
  distribuir_humano_summary: 'gpt-4.1-mini',
  salesbot_curso: 'gpt-4.1',             // melhor accuracy pra normalizar nome de curso (rara execução)
  feedback: 'gpt-4.1-mini',
  ia_feedback: 'gpt-4.1',               // auditor de qualidade da IA (mais preciso)
  prompt_optimizer: 'o3-mini',           // analisador de violações e proposta de mudança de prompt
  learning_analyzer: 'o3-mini',          // analisador de batches de aprendizado positivo
  vision: 'gpt-4.1-mini',
  transcribe: 'whisper-1',               // gpt-4o-transcribe é mais caro
  embeddings: 'text-embedding-3-small',  // 3-large é 6.5x mais caro
}

/**
 * Mapa papel → env de primeira escolha.
 * Convenção: OPENAI_MODEL_<UPPER_SNAKE>.
 */
const ROLE_ENVS = {
  orchestrator: 'OPENAI_MODEL_ORCHESTRATOR',
  query_rewrite: 'OPENAI_MODEL_QUERY_REWRITE',
  inscricao_summary: 'OPENAI_MODEL_INSCRICAO',
  distribuir_humano_summary: 'OPENAI_MODEL_DISTRIBUIR_HUMANO',
  salesbot_curso: 'OPENAI_MODEL_SALESBOT_CURSO',
  feedback: 'OPENAI_MODEL_FEEDBACK',
  ia_feedback: 'OPENAI_MODEL_IA_FEEDBACK',
  prompt_optimizer: 'OPENAI_MODEL_PROMPT_OPTIMIZER',
  learning_analyzer: 'OPENAI_MODEL_LEARNING_ANALYZER',
  vision: 'OPENAI_MODEL_VISION',
  transcribe: 'OPENAI_MODEL_TRANSCRIBE',
  embeddings: 'OPENAI_MODEL_EMBEDDINGS',
}

/**
 * Envs legadas (compatibilidade pra frente — quem ainda tiver no .env
 * continua funcionando, mas não recomendamos mais).
 */
const LEGACY_ENVS_BY_ROLE = {
  orchestrator: ['OPENAI_AGENT_MODEL', 'OPENAI_MODEL'],
  feedback: ['FEEDBACK_JOB_OPENAI_MODEL', 'OPENAI_FEEDBACK_MODEL'],
  vision: ['OPENAI_VISION_MODEL'],
  transcribe: ['OPENAI_TRANSCRIBE_MODEL'],
  embeddings: ['OPENAI_EMBEDDING_MODEL'],
}

function readEnv(env, key) {
  if (!key) return ''
  const v = env?.[key]
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Resolve o nome do modelo para um papel.
 *
 * @param {Record<string,string>} env  process.env (ou compatível)
 * @param {keyof typeof DEFAULTS} role
 * @param {{ tool?: string }} [opts]
 *   tool: nome da tool (ex: 'buscar_precos'). Se passado, primeiro
 *         olha override por tool: OPENAI_MODEL_TOOL_<UPPER>.
 * @returns {string} nome do modelo (ex: 'gpt-4.1-mini')
 */
export function resolveModel(env, role, opts = {}) {
  const safeEnv = env || {}
  const tool = opts.tool ? String(opts.tool).toUpperCase().replace(/[^A-Z0-9_]/g, '_') : null

  // 1) override por tool
  if (tool) {
    const v = readEnv(safeEnv, `OPENAI_MODEL_TOOL_${tool}`)
    if (v) return v
  }
  // 2) env do papel
  const v2 = readEnv(safeEnv, ROLE_ENVS[role])
  if (v2) return v2
  // 3) envs legadas do papel
  for (const k of LEGACY_ENVS_BY_ROLE[role] || []) {
    const v3 = readEnv(safeEnv, k)
    if (v3) return v3
  }
  // 4) fallback global legado (apenas para papéis "chat-like")
  const isChatLikeRole = role !== 'embeddings' && role !== 'transcribe'
  if (isChatLikeRole) {
    const vGlobal = readEnv(safeEnv, 'OPENAI_AGENT_MODEL') || readEnv(safeEnv, 'OPENAI_MODEL')
    if (vGlobal) return vGlobal
  }
  // 5) default do papel
  return DEFAULTS[role]
}

/**
 * Snapshot dos modelos resolvidos no momento. Útil pra `/api/evolution/health`
 * e pra debugar configuração em produção.
 */
export function getModelRegistrySnapshot(env) {
  const out = {}
  for (const role of Object.keys(DEFAULTS)) {
    out[role] = {
      resolved: resolveModel(env, role),
      default: DEFAULTS[role],
      env: ROLE_ENVS[role],
      legacyEnvs: LEGACY_ENVS_BY_ROLE[role] || [],
    }
  }
  return out
}

/** Defaults expostos pra testes / docs. */
export const MODEL_REGISTRY_DEFAULTS = { ...DEFAULTS }
