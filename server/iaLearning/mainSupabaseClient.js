/**
 * Cliente Supabase principal via PostgREST direto.
 * Extraído de server/kommoEvents/kommoEventsJob.js para reuso
 * por outros módulos sem duplicação.
 */

export function makeMainSupabase(env) {
  const url = (env.SUPABASE_URL || '').replace(/\/$/, '')
  const key = env.SUPABASE_KEY || ''
  if (!url || !key) return null

  const baseHeaders = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }

  async function request(method, path, body, extraHeaders = {}) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { ...baseHeaders, ...extraHeaders },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`Supabase principal ${method} ${path} ${res.status}: ${text.slice(0, 300)}`)
    }
    return text ? JSON.parse(text) : null
  }

  return {
    select: (table, query = '') =>
      request('GET', `/rest/v1/${table}${query ? '?' + query : ''}`),
    insert: (table, row, extraHeaders = {}) =>
      request('POST', `/rest/v1/${table}`, row, extraHeaders),
    update: (table, query, patch) =>
      request('PATCH', `/rest/v1/${table}?${query}`, patch, { Prefer: 'return=minimal' }),
  }
}
