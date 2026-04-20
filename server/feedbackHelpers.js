// Helpers puros para o job de feedback comercial
// (reimplementa as funções dos nodes Code do n8n)

export function normalizeConsultor(value) {
  if (value === null || value === undefined) return null
  const s = String(value).trim().replace(/\s+/g, ' ')
  return s || null
}

export function parseDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function toIso(value) {
  const d = parseDate(value)
  return d ? d.toISOString() : null
}

export function numericOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function average(values) {
  const arr = values.filter((v) => Number.isFinite(v))
  if (!arr.length) return null
  return Number((arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2))
}

export function maxOrNull(values) {
  const arr = values.filter((v) => Number.isFinite(v))
  if (!arr.length) return null
  return Math.max(...arr)
}

export function contentFromMessage(row) {
  const text = row.message_text != null ? String(row.message_text).trim() : ''
  const media = row.media_url != null ? String(row.media_url).trim() : ''
  if (text && media) return `${text}\n[MIDIA]: ${media}`
  if (text) return text
  if (media) return `[MIDIA]: ${media}`
  return '[SEM CONTEUDO]'
}

export function completenessScore(row) {
  let score = 0
  const keys = [
    'contact_id', 'lead_id', 'consultor_responsavel', 'message_text', 'media_url',
    'sender_name', 'sent_at', 'created_at', 'chat_id', 'response_time_seconds',
  ]
  for (const k of keys) {
    if (row[k] !== null && row[k] !== undefined && row[k] !== '') score++
  }
  return score
}

export function completenessScoreMessage(row) {
  let score = 0
  const keys = [
    'consultor_responsavel', 'message_text', 'media_url', 'sender_name',
    'sent_at', 'created_at', 'response_time_seconds',
  ]
  for (const k of keys) {
    if (row[k] !== null && row[k] !== undefined && row[k] !== '') score++
  }
  return score
}

export function chooseBetterRow(current, candidate, scoreFn = completenessScore) {
  if (!current) return candidate
  const s1 = scoreFn(current)
  const s2 = scoreFn(candidate)
  if (s2 > s1) return candidate
  if (s1 > s2) return current
  const c1 = parseDate(current.created_at)?.getTime() || 0
  const c2 = parseDate(candidate.created_at)?.getTime() || 0
  if (c2 > c1) return candidate
  if (c1 > c2) return current
  const i1 = Number(current.id || current.source_id || 0)
  const i2 = Number(candidate.id || candidate.source_id || 0)
  return i2 > i1 ? candidate : current
}

export function parseJsonMaybe(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return null }
}

// Horário / fuso São Paulo

export function getSaoPauloParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short',
  }).formatToParts(date)
  const out = {}
  for (const p of parts) if (p.type !== 'literal') out[p.type] = p.value
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second),
    weekday: String(out.weekday || '').toLowerCase(),
  }
}

export function isSundayInSaoPaulo(date) {
  return getSaoPauloParts(date).weekday === 'sun'
}

export function isOutOfHours(date) {
  const sp = getSaoPauloParts(date)
  const totalMinutes = sp.hour * 60 + sp.minute
  if (sp.weekday === 'sun') return true
  return totalMinutes >= 18 * 60 || totalMinutes < 9 * 60
}

export function isBusinessHour(date) {
  const sp = getSaoPauloParts(date)
  const totalMinutes = sp.hour * 60 + sp.minute
  if (sp.weekday === 'sun') return false
  return totalMinutes >= 9 * 60 && totalMinutes < 18 * 60
}

export function getLocalDateKey(date) {
  const p = getSaoPauloParts(date)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

function hoursBetween(a, b) {
  if (!a || !b) return null
  return Number((((b.getTime() - a.getTime()) / 3600000)).toFixed(2))
}

function countSundaysBetweenInclusive(start, end) {
  if (!start || !end) return 0
  const startDate = parseDate(start); const endDate = parseDate(end)
  if (!startDate || !endDate || endDate < startDate) return 0
  const visited = new Set()
  const cursor = new Date(startDate)
  while (cursor <= endDate) {
    visited.add(getLocalDateKey(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  let sundays = 0
  for (const key of visited) {
    const [y, m, d] = key.split('-').map(Number)
    const utcMidday = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
    if (isSundayInSaoPaulo(utcMidday)) sundays++
  }
  return sundays
}

export function getAllowedFollowupHours(start, end) {
  if (!start || !end) return 24
  const sundays = countSundaysBetweenInclusive(start, end)
  return 24 + sundays * 24
}

export function exceededFollowupDeadline(start, end) {
  if (!start || !end) return false
  const elapsed = hoursBetween(start, end)
  if (elapsed === null) return false
  return elapsed > getAllowedFollowupHours(start, end)
}

export function hasUrl(text) {
  return /https?:\/\/|www\./i.test(String(text || ''))
}

export function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function detectDecline(text) {
  const t = normalizeText(text)
  const strongPatterns = [
    /sem interesse/, /nao tenho interesse/, /nao quero/, /nao quero mais/,
    /nao desejo/, /nao vou continuar/, /nao pretendo continuar/, /nao vou seguir/,
    /pode encerrar/, /pode cancelar/, /desconsidera/, /pare de mandar/,
    /nao me chame/, /nao chama/, /nao consigo agora/, /nao tenho condicoes/,
    /ja me matriculei/, /ja fechei/, /ja resolvi/, /vou fazer estetica/,
    /quero estetica/, /prefiro outro curso/, /vou fazer outro curso/,
    /escolhi outro curso/, /no momento gostaria de fazer/,
  ]
  const weakPatterns = [
    /depois eu vejo/, /vou pensar/, /mais tarde/, /agora nao/, /talvez depois/,
  ]
  const strong = strongPatterns.some((r) => r.test(t))
  const weak = weakPatterns.some((r) => r.test(t))
  return { strong, weak, any: strong || weak }
}

export function looksLikeWeakClosingWithoutNextStep(text) {
  const t = normalizeText(text)
  const weakPatterns = [
    /qualquer duvida/, /fico a disposicao/, /estou a disposicao/,
    /me chama qualquer coisa/, /se precisar estou aqui/, /qualquer coisa me avisa/,
    /qualquer coisa pode chamar/,
  ]
  const strongPatterns = [
    /vamos/, /posso te ajudar com a matricula/, /posso te ajudar na inscricao/,
    /quer que eu/, /podemos seguir/, /vamos dar sequencia/,
    /te ajudo a finalizar/, /te ajudo a concluir/, /qual melhor horario/,
    /prefere/, /me envia/, /me manda/, /podemos avançar/, /quer continuar/,
  ]
  return weakPatterns.some((r) => r.test(t)) && !strongPatterns.some((r) => r.test(t))
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

// ID de execução legível
let _counter = 0
export function generateJobExecutionId() {
  const now = new Date()
  const date = now.toISOString().slice(2, 10).replace(/-/g, '')
  const time = now.toISOString().slice(11, 16).replace(':', '')
  _counter = (_counter + 1) % 1000
  const seq = String(_counter).padStart(3, '0')
  return `FB-${date}-${time}-${seq}`
}
