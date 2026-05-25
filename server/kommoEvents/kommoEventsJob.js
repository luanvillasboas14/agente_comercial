import { listEventsByConsultoresAndDate } from '../kommoClient.js'
import { getConsultoresAtivos } from './consultoresSource.js'
import { makeMainSupabase } from '../iaLearning/mainSupabaseClient.js'

const SP_TZ_OFFSET_MIN = -180 // UTC-3, fixo (sem horário de verão no BR desde 2019)

function getYesterdayWindowInSpTz(now = new Date()) {
  const spNowMs = now.getTime() + SP_TZ_OFFSET_MIN * 60 * 1000
  const spYesterdayMs = spNowMs - 24 * 60 * 60 * 1000
  const d = new Date(spYesterdayMs)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  // 00:00:00 SP = 03:00:00 UTC
  // 23:59:59 SP = 02:59:59 UTC do dia seguinte
  const fromUtc = new Date(`${yyyy}-${mm}-${dd}T03:00:00Z`)
  const toUtc = new Date(fromUtc.getTime() + 24 * 60 * 60 * 1000 - 1000)
  return {
    fromUnix: Math.floor(fromUtc.getTime() / 1000),
    toUnix: Math.floor(toUtc.getTime() / 1000),
    referenceDate: `${yyyy}-${mm}-${dd}`,
  }
}

function chunkArray(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function runKommoEventsJob(env, { referenceDate = null, trigger = 'manual' } = {}) {
  console.log(`[KommoEvents] iniciando job trigger=${trigger} ref=${referenceDate || 'D-1'}`)

  const db = makeMainSupabase(env)
  if (!db) {
    console.error('[KommoEvents] SUPABASE_URL / SUPABASE_KEY não configurados — abortando')
    return { ok: false, reason: 'no_supabase' }
  }

  // 1) Resolver janela
  let window
  if (referenceDate) {
    const fromUtc = new Date(`${referenceDate}T03:00:00Z`)
    const toUtc = new Date(fromUtc.getTime() + 24 * 60 * 60 * 1000 - 1000)
    window = {
      fromUnix: Math.floor(fromUtc.getTime() / 1000),
      toUnix: Math.floor(toUtc.getTime() / 1000),
      referenceDate,
    }
  } else {
    window = getYesterdayWindowInSpTz()
  }

  // 2) Buscar consultores
  const consultores = await getConsultoresAtivos(env)
  if (consultores.length === 0) {
    console.warn('[KommoEvents] nenhum consultor encontrado, abortando')
    return { ok: false, reason: 'no_consultores' }
  }

  // 3) Criar run no Supabase
  const groupSize = Math.max(1, Math.min(50, Number(env.KOMMO_EVENTS_GROUP_SIZE || 10)))
  const groups = chunkArray(consultores, groupSize)
  const runId = await createSyncRun(db, {
    reference_date: window.referenceDate,
    metadata: {
      trigger,
      total_consultores: consultores.length,
      group_size: groupSize,
      window,
    },
  })

  let totalPages = 0
  let totalReceived = 0
  let totalInserted = 0
  let criticalError = null

  const delayPage = Math.max(500, Number(env.KOMMO_EVENTS_DELAY_PAGE_MS || 2500))
  const delayGroup = Math.max(5000, Number(env.KOMMO_EVENTS_DELAY_GROUP_MS || 45000))
  const maxRetriesPage = Math.max(1, Number(env.KOMMO_EVENTS_MAX_RETRIES_PAGE || 3))

  try {
    for (let gi = 0; gi < groups.length; gi += 1) {
      const group = groups[gi]
      const ids = group.map((c) => c.kommoUserId)
      console.log(`[KommoEvents] grupo ${gi + 1}/${groups.length} ids=${ids.join(',')}`)

      let page = 1
      const maxPages = 200

      while (page <= maxPages) {
        let attempt = 0
        let result = null

        while (attempt < maxRetriesPage) {
          attempt += 1
          result = await listEventsByConsultoresAndDate(env, {
            createdByIds: ids,
            fromUnix: window.fromUnix,
            toUnix: window.toUnix,
            page,
            limit: 250,
          })

          if (result.ok) break

          if (result.status === 429) {
            const waitMs = result.retryAfterMs || 60_000
            console.warn(`[KommoEvents] 429 grupo=${gi + 1} page=${page} attempt=${attempt}, esperando ${waitMs}ms`)
            await sleep(waitMs)
            continue
          }

          if (result.status === 403) {
            criticalError = `403 Forbidden grupo=${gi + 1} page=${page} — possivel token invalido ou IP bloqueado. Abortando.`
            console.error(`[KommoEvents] ${criticalError}`)
            throw new Error(criticalError)
          }

          console.warn(`[KommoEvents] erro grupo=${gi + 1} page=${page} attempt=${attempt}: status=${result.status} err=${result.error}`)
          if (attempt < maxRetriesPage) await sleep(5000 * attempt)
        }

        if (!result || !result.ok) {
          console.warn(`[KommoEvents] desistindo de page=${page} grupo=${gi + 1} apos ${maxRetriesPage} tentativas`)
          break
        }

        totalPages += 1
        const events = Array.isArray(result.events) ? result.events : []
        totalReceived += events.length
        console.log(`[KommoEvents] grupo=${gi + 1} page=${page} recebidos=${events.length}`)

        if (events.length === 0) break

        const inserted = await insertEventsBatch(db, events, runId)
        totalInserted += inserted

        if (events.length < 250) break
        page += 1
        await sleep(delayPage)
      }

      if (gi < groups.length - 1) {
        console.log(`[KommoEvents] pausa entre grupos: ${delayGroup}ms`)
        await sleep(delayGroup)
      }
    }

    await finishSyncRun(db, runId, {
      status: 'success',
      total_groups: groups.length,
      total_pages: totalPages,
      total_events_received: totalReceived,
      total_events_inserted: totalInserted,
    })
    console.log(`[KommoEvents] ✓ done grupos=${groups.length} pages=${totalPages} received=${totalReceived} inserted=${totalInserted}`)
    return { ok: true, runId, totalGroups: groups.length, totalPages, totalReceived, totalInserted }
  } catch (err) {
    const isCritical = !!criticalError
    await finishSyncRun(db, runId, {
      status: isCritical ? 'failed_critical' : 'failed',
      total_groups: groups.length,
      total_pages: totalPages,
      total_events_received: totalReceived,
      total_events_inserted: totalInserted,
      error_message: err.message,
    }).catch(() => {})
    console.error('[KommoEvents] FAIL:', err.message)
    throw err
  }
}

// === Persistência ===

async function createSyncRun(db, payload) {
  const rows = await db.insert(
    'kommo_event_sync_runs',
    {
      reference_date: payload.reference_date,
      status: 'running',
      metadata: payload.metadata || {},
    },
    { Prefer: 'return=representation' },
  )
  const row = Array.isArray(rows) ? rows[0] : rows
  if (!row?.id) throw new Error('[KommoEvents] createSyncRun: falha ao obter id do run inserido')
  console.log(`[KommoEvents] sync run criado id=${row.id} ref=${payload.reference_date}`)
  return row.id
}

async function finishSyncRun(db, runId, patch) {
  await db.update(
    'kommo_event_sync_runs',
    `id=eq.${runId}`,
    {
      finished_at: new Date().toISOString(),
      status: patch.status,
      total_groups: patch.total_groups ?? 0,
      total_pages: patch.total_pages ?? 0,
      total_events_received: patch.total_events_received ?? 0,
      total_events_inserted: patch.total_events_inserted ?? 0,
      ...(patch.error_message != null ? { error_message: patch.error_message } : {}),
    },
  )
}

async function insertEventsBatch(db, events, syncRunId) {
  if (!events.length) return 0

  const rows = events
    .map((e) => {
      const id = e?.id != null ? String(e.id) : ''
      if (!id) return null
      const createdAtSec = Number(e?.created_at)
      const createdAtIso = Number.isFinite(createdAtSec) && createdAtSec > 0
        ? new Date(createdAtSec * 1000).toISOString()
        : new Date().toISOString()
      const hasValueData = e?.value_after != null || e?.value_before != null
      return {
        kommo_event_id: id,
        created_at_kommo: createdAtIso,
        created_by: e?.created_by != null ? Number(e.created_by) : null,
        entity_type: e?.entity_type || e?.entity || null,
        entity_id: e?.entity_id != null ? Number(e.entity_id) : null,
        event_type: e?.type || null,
        event_data: hasValueData
          ? { value_after: e?.value_after ?? null, value_before: e?.value_before ?? null }
          : null,
        raw: e,
        sync_run_id: syncRunId,
      }
    })
    .filter(Boolean)

  const CHUNK = 100
  let totalInserted = 0
  const totalPreparados = rows.length
  const totalRecebidos = events.length
  const totalDescartados = totalRecebidos - totalPreparados

  if (totalDescartados > 0) {
    console.warn(
      `[KommoEvents] normalize: ${totalDescartados} eventos descartados por falta de id (recebidos=${totalRecebidos} preparados=${totalPreparados})`,
    )
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    // return=representation com ignore-duplicates: o response contém só as linhas
    // realmente inseridas (duplicados são silenciosamente ignorados).
    const inserted = await db.insert(
      'kommo_consultor_eventos?on_conflict=kommo_event_id',
      chunk,
      { Prefer: 'resolution=ignore-duplicates,return=representation' },
    )
    const count = Array.isArray(inserted) ? inserted.length : 0
    totalInserted += count
    console.log(
      `[KommoEvents] insert chunk ${Math.floor(i / CHUNK) + 1}: enviados=${chunk.length} inseridos=${count} ignorados=${chunk.length - count}`,
    )
  }

  return totalInserted
}

export async function getRecentRuns(env, limit = 5) {
  const db = makeMainSupabase(env)
  if (!db) return []
  const lim = Math.max(1, Math.min(50, Number(limit) || 5))
  const rows = await db.select(
    'kommo_event_sync_runs',
    `select=id,started_at,finished_at,reference_date,status,total_groups,total_pages,total_events_received,total_events_inserted,error_message,metadata&order=id.desc&limit=${lim}`,
  )
  return Array.isArray(rows) ? rows : []
}
