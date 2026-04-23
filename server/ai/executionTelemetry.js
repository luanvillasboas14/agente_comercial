/**
 * Telemetria server-side das execuções do agente.
 *
 * Espelha o src/lib/executionStore.js do front (Playground) — mesma tabela
 * (`mensagens_ia`), mesmo formato de id (`EX-YYMMDD-HHMM-NNN`) e mesmas
 * colunas — para que o ExecutionViewer da UI consiga listar tanto execuções
 * do Playground quanto as que vieram do webhook/Evolution em produção.
 *
 * Por que não reusar o arquivo do front:
 *   - `import.meta.env.DEV` é coisa de Vite, não roda no Node.
 *   - O front passa pelo proxy /api/supabase; aqui a gente fala direto com
 *     o Supabase REST usando SUPABASE_URL / SUPABASE_KEY.
 */
let counter = 0

/**
 * Gera um id de execução legível. Formato: "EX-YYMMDD-HHMM-NNN".
 * Exemplo: EX-260423-1545-001.
 * Bom para grep/logs, e é o mesmo formato usado pelo Playground.
 */
export function generateExecutionId() {
  const now = new Date()
  const date = now.toISOString().slice(2, 10).replace(/-/g, '')
  const time = now.toISOString().slice(11, 16).replace(':', '')
  counter = (counter + 1) % 1000
  const seq = String(counter).padStart(3, '0')
  return `EX-${date}-${time}-${seq}`
}

function getSupabaseConfig(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
  }
}

/**
 * Salva/atualiza uma execução do agente na tabela `mensagens_ia` (mesmo
 * schema que o executionStore.js do front já usa).
 * Se a chave primária já existir a linha é sobrescrita
 * (Prefer: resolution=merge-duplicates).
 *
 * Campos adicionais (telefone, leadId, origem) entram dentro de `usage` pra
 * não depender de colunas extras na tabela — assim o ExecutionViewer
 * continua funcionando igual. Quando você criar as colunas dedicadas, dá
 * pra promover esses valores pra top-level sem quebrar nada.
 *
 * @returns {Promise<{ ok: boolean, status?: number, error?: string }>}
 */
export async function saveExecution(env, execution) {
  const { url, key } = getSupabaseConfig(env)
  if (!url || !key) {
    return { ok: false, error: 'SUPABASE_URL / SUPABASE_KEY ausentes' }
  }
  const usage = { ...(execution.usage || {}) }
  if (execution.telefone) usage.telefone = execution.telefone
  if (execution.leadId != null) usage.lead_id = execution.leadId
  if (execution.origem) usage.origem = execution.origem

  const row = {
    id: execution.id,
    created_at: execution.timestamp || new Date().toISOString(),
    user_message: execution.userMessage || '',
    model: execution.model || null,
    steps: execution.steps || [],
    tool_calls: execution.toolCalls || [],
    response: execution.response ?? null,
    error: execution.error ?? null,
    total_duration_ms: execution.totalDurationMs || 0,
    usage,
  }
  try {
    const res = await fetch(`${url}/rest/v1/mensagens_ia`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return { ok: false, status: res.status, error: body.slice(0, 400) }
    }
    return { ok: true, status: res.status }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}
