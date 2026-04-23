/**
 * Cliente mínimo da API do Kommo — só o que a gente precisa para ligar envio
 * de mensagens pelo WhatsApp (nota no lead) e para descobrir o id_lead a partir
 * do telefone.
 *
 * Hoje o inscricaoTool / distribuirHumanoTool têm cópias locais de kommoFetch;
 * o ideal é migrar essas tools para usarem este módulo, mas isso fica para um
 * refactor separado.
 *
 * Env:
 *   KOMMO_BASE_URL       ex: https://admamoeduitcombr.kommo.com
 *   KOMMO_ACCESS_TOKEN   Bearer (OAuth ou long-lived)
 */

function getConfig(env) {
  return {
    base: (env.KOMMO_BASE_URL || '').replace(/\/$/, ''),
    token: env.KOMMO_ACCESS_TOKEN || '',
  }
}

async function kommoFetch(env, path, { method = 'GET', body } = {}) {
  const { base, token } = getConfig(env)
  if (!base || !token) {
    return {
      ok: false,
      code: 'KOMMO_NOT_CONFIGURED',
      error: 'Configure KOMMO_BASE_URL e KOMMO_ACCESS_TOKEN.',
    }
  }
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
    return { ok: res.ok, status: res.status, data, raw }
  } catch (e) {
    return { ok: false, code: 'KOMMO_FETCH_FAILED', error: e.message }
  }
}

function summarizeError(r) {
  if (r.error) return r.error
  if (typeof r.raw === 'string') return r.raw.slice(0, 400)
  return `status ${r.status}`
}

/**
 * Busca o primeiro lead associado ao telefone.
 * Usa o search full-text do Kommo (?query=<digitos>) que inclui telefones de
 * contatos vinculados ao lead.
 *
 * @returns { ok, lead?, matched, status?, error? }
 */
export async function findLeadByPhone(env, telefone) {
  const digits = String(telefone || '').replace(/[^0-9]/g, '')
  if (!digits) {
    return { ok: false, code: 'MISSING_TELEFONE', error: 'telefone vazio', matched: 0 }
  }
  const r = await kommoFetch(
    env,
    `/api/v4/leads?query=${encodeURIComponent(digits)}&with=contacts&limit=10`,
  )
  if (!r.ok) {
    return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r), matched: 0 }
  }
  const leads = r.data?._embedded?.leads || []
  return {
    ok: true,
    lead: leads[0] || null,
    matched: leads.length,
    leads,
  }
}

/**
 * Cria uma nota comum no lead indicado.
 * @returns { ok, status?, data?, error? }
 */
export async function createLeadNote(env, leadId, text) {
  if (leadId == null || leadId === '') {
    return { ok: false, code: 'MISSING_LEAD_ID', error: 'leadId ausente' }
  }
  const r = await kommoFetch(env, `/api/v4/leads/${leadId}/notes`, {
    method: 'POST',
    body: [{ note_type: 'common', params: { text: String(text ?? '') } }],
  })
  if (!r.ok) {
    return { ok: false, code: r.code || 'KOMMO_ERROR', status: r.status, error: summarizeError(r) }
  }
  return { ok: true, status: r.status, data: r.data }
}
