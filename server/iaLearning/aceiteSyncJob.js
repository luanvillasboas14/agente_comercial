/**
 * Job de sync de eventos de aceite sem filtro por consultor.
 * Busca TODOS os lead_status_changed de D-1 sem filter[created_by],
 * filtra localmente por ACEITE_STATUS_ID + ACEITE_PIPELINE_ID e persiste
 * em ia_aceites_eventos (Supabase principal). Idempotente via on_conflict.
 *
 * ENVs:
 *   KOMMO_BASE_URL, KOMMO_ACCESS_TOKEN
 *   KOMMO_ACEITE_STATUS_ID   (default 48566207)
 *   KOMMO_ACEITE_PIPELINE_ID (default 5481944)
 *   SUPABASE_URL, SUPABASE_KEY
 */

import { makeMainSupabase } from './mainSupabaseClient.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const MAX_PAGES = 100
const PAGE_LIMIT = 250
const PAGE_SLEEP_MS = 1500
const CHUNK_SIZE = 100

export async function runAceiteSyncJob(env, { trigger = 'manual' } = {}) {
  const aceiteStatusId = Number(env.KOMMO_ACEITE_STATUS_ID || 48566207)
  const aceitePipelineId = Number(env.KOMMO_ACEITE_PIPELINE_ID || 5481944)
  const kommoBaseUrl = (env.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env.KOMMO_ACCESS_TOKEN || ''

  if (!kommoBaseUrl || !token) {
    console.error('[IaLearning/aceiteSync] KOMMO_BASE_URL ou KOMMO_ACCESS_TOKEN não configurados — abortando')
    return { ok: false, reason: 'no_kommo_config' }
  }

  // Janela D-1 em UTC: 00:00:00 até 23:59:59
  const nowUtc = new Date()
  const yesterday = new Date(Date.UTC(
    nowUtc.getUTCFullYear(),
    nowUtc.getUTCMonth(),
    nowUtc.getUTCDate() - 1,
  ))
  const fromTs = Math.floor(yesterday.getTime() / 1000)
  const toTs = fromTs + 86399 // 23:59:59

  const ddmm = `${String(yesterday.getUTCDate()).padStart(2, '0')}${String(yesterday.getUTCMonth() + 1).padStart(2, '0')}`
  console.log(`[IaLearning/aceiteSync] iniciando trigger=${trigger} janela=${ddmm}`)

  const startMs = Date.now()
  const allAceites = []
  let totalEventosRecebidos = 0
  let totalPaginas = 0
  let page = 1

  while (page <= MAX_PAGES) {
    const url =
      `${kommoBaseUrl}/api/v4/events` +
      `?filter[type]=lead_status_changed` +
      `&filter[created_at][from]=${fromTs}` +
      `&filter[created_at][to]=${toTs}` +
      `&page=${page}` +
      `&limit=${PAGE_LIMIT}`

    let res
    try {
      res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      })
    } catch (fetchErr) {
      console.error(`[IaLearning/aceiteSync] erro de rede page=${page}: ${fetchErr.message}`)
      return { ok: false, reason: 'fetch_error', error: fetchErr.message }
    }

    if (res.status === 403) {
      console.error('[IaLearning/aceiteSync] 403 Forbidden — token inválido ou sem permissão. Abortando.')
      return { ok: false, reason: 'forbidden_403' }
    }

    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get('Retry-After') || 60)
      const waitMs = Math.min(retryAfterSec * 1000, 120_000)
      console.warn(`[IaLearning/aceiteSync] 429 rate limit page=${page} — aguardando ${waitMs}ms`)
      await sleep(waitMs)
      continue // retry same page
    }

    // 204 = sem eventos na janela; alguns clients retornam 404 para página vazia
    if (res.status === 204 || res.status === 404) break

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error(`[IaLearning/aceiteSync] HTTP ${res.status} page=${page}: ${text.slice(0, 200)}`)
      return { ok: false, reason: `http_${res.status}`, error: text.slice(0, 200) }
    }

    let data
    try {
      data = await res.json()
    } catch (parseErr) {
      console.error(`[IaLearning/aceiteSync] JSON parse error page=${page}: ${parseErr.message}`)
      return { ok: false, reason: 'parse_error', error: parseErr.message }
    }

    const items = data?._embedded?.events || []
    totalEventosRecebidos += items.length
    totalPaginas = page

    const aceitesDaPagina = items.filter((e) => {
      const va = Array.isArray(e.value_after) ? e.value_after[0] : null
      if (!va?.lead_status) return false
      return (
        Number(va.lead_status.id) === aceiteStatusId &&
        Number(va.lead_status.pipeline_id) === aceitePipelineId
      )
    })

    console.log(
      `[IaLearning/aceiteSync] page=${page} recebidos=${items.length} aceites_filtrados=${aceitesDaPagina.length}`,
    )
    allAceites.push(...aceitesDaPagina)

    if (items.length < PAGE_LIMIT) break // última página
    page++
    await sleep(PAGE_SLEEP_MS)
  }

  const totalAceites = allAceites.length

  if (totalAceites === 0) {
    const durationMs = Date.now() - startMs
    console.log(
      `[IaLearning/aceiteSync] ✓ done pages=${totalPaginas} events_total=${totalEventosRecebidos} aceites=0 inserted=0`,
    )
    return { ok: true, totalEventos: totalEventosRecebidos, totalAceites: 0, totalInseridos: 0, totalPaginas, durationMs }
  }

  const db = makeMainSupabase(env)
  if (!db) {
    console.error('[IaLearning/aceiteSync] SUPABASE_URL / SUPABASE_KEY não configurados — abortando inserção')
    return { ok: false, reason: 'no_supabase' }
  }

  // Mapeia eventos Kommo → linhas da tabela
  const rows = allAceites.map((e) => {
    const va = Array.isArray(e.value_after) ? e.value_after[0] : null
    const ls = va?.lead_status || {}
    return {
      kommo_event_id: String(e.id),
      entity_id: Number(e.entity_id),
      created_by: e.created_by ?? null,
      created_at_kommo: new Date(e.created_at * 1000).toISOString(),
      status_id: Number(ls.id),
      pipeline_id: Number(ls.pipeline_id),
      raw: e,
    }
  })

  // Insere em chunks, idempotente via on_conflict
  let totalInseridos = 0
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE)
    try {
      // Usa path hack para passar ?on_conflict como query param no PostgREST.
      // makeMainSupabase.insert constrói: POST /rest/v1/{table} — o ? no nome
      // vira query string válida.
      await db.insert(
        'ia_aceites_eventos?on_conflict=kommo_event_id',
        chunk,
        { Prefer: 'resolution=ignore-duplicates' },
      )
      totalInseridos += chunk.length
    } catch (insertErr) {
      console.error(
        `[IaLearning/aceiteSync] inserção chunk ${i}–${i + chunk.length} falhou: ${insertErr.message}`,
      )
    }
  }

  const durationMs = Date.now() - startMs
  console.log(
    `[IaLearning/aceiteSync] ✓ done pages=${totalPaginas} events_total=${totalEventosRecebidos} aceites=${totalAceites} inserted=${totalInseridos}`,
  )

  return {
    ok: true,
    totalEventos: totalEventosRecebidos,
    totalAceites,
    totalInseridos,
    totalPaginas,
    durationMs,
  }
}
