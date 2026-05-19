/**
 * Cliente Supabase REST compartilhado para o banco de Feedback.
 * Usado por promptVersionStore, proposalsStore, violationsRanking e promptAnalyzer.
 *
 * Replica o padrão de makeSupabaseClient de iaFeedbackJob.js,
 * mas como utilitário exportável para evitar duplicação.
 */

async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(url, options)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`Timeout: ${options.method || 'GET'} ${url} não respondeu em ${timeoutMs}ms`)
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}

export function makeSupabaseClient(url, key, { timeoutMs = 60_000 } = {}) {
  const baseHeaders = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }

  async function request(method, path, body, extraHeaders = {}) {
    const res = await fetchWithTimeout(
      `${url}${path}`,
      {
        method,
        headers: { ...baseHeaders, ...extraHeaders },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      timeoutMs,
    )
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Supabase ${method} ${path} ${res.status}: ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : null
  }

  return {
    select: (table, query = '') =>
      request('GET', `/rest/v1/${table}${query ? '?' + query : ''}`),
    insert: (table, row, returning = false) =>
      request('POST', `/rest/v1/${table}`, row, returning ? { Prefer: 'return=representation' } : {}),
    update: (table, query, patch) =>
      request('PATCH', `/rest/v1/${table}?${query}`, patch, { Prefer: 'return=minimal' }),
  }
}

/**
 * Cria e retorna um cliente Supabase de Feedback a partir de `env`.
 * Retorna null (sem throw) se as envs não estiverem configuradas.
 */
export function getFeedbackSupabase(env, opts = {}) {
  const url = (env?.SUPABASE_URL_FEEDBACK || '').replace(/\/$/, '')
  const key = env?.SUPABASE_KEY_FEEDBACK || ''
  if (!url || !key) return null
  return makeSupabaseClient(url, key, opts)
}
