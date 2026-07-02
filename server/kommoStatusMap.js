/**
 * Mapa de status (fases) do funil Kommo → nome legível + categoria.
 *
 * Usado pelo feedback comercial pra:
 *   - mostrar a fase do lead no dashboard e permitir filtro por fase;
 *   - baixar a nota de atendimentos cujo lead foi pra "Perdido".
 *
 * Estratégia em 2 camadas:
 *   1. MAPA ESTÁTICO (KNOWN_STATUS): fases que já conhecemos com certeza.
 *      Sempre disponível, inclusive em dev sem token do Kommo.
 *   2. CARGA DINÂMICA (loadKommoStatusMap): em produção, com
 *      KOMMO_BASE_URL/KOMMO_ACCESS_TOKEN, busca todos os pipelines/statuses
 *      do Kommo 1x e cacheia — assim os nomes ficam sempre certos sem
 *      precisar hardcodar cada status novo. Se a carga falhar, cai no
 *      estático.
 *
 * Categorias: 'ganho' | 'perdido' | 'em_andamento'.
 */

// Status "de sistema" do Kommo (iguais em toda conta):
//   142 = Venda ganha, 143 = Venda perdida.
// Os demais são específicos da conta (descobertos via contexto do projeto).
export const KNOWN_STATUS = {
  142: { name: 'Ganho', categoria: 'ganho' },
  143: { name: 'Perdido', categoria: 'perdido' },
  48566207: { name: 'Aceite', categoria: 'ganho' },
  74941508: { name: 'Aguardando resposta', categoria: 'em_andamento' },
}

/**
 * Deriva a categoria a partir do id e do nome do status.
 * id 142/143 são universais; para os demais usa heurística de nome.
 */
export function categorizeStatus(statusId, name) {
  const id = Number(statusId)
  if (id === 142) return 'ganho'
  if (id === 143) return 'perdido'
  // Aceite (48566207): quem chega aqui já fechou — trata como 'ganho' pra
  // efeito de nota (bônus) e exibição de fase. Depois do aceite o lead sobe
  // pra "Ganho" (142) no dia seguinte.
  if (id === 48566207) return 'ganho'
  const n = String(name || '').toLowerCase()
  if (/perdid|lost|descartad/.test(n)) return 'perdido'
  if (/ganho|won|venda ganha|matriculad|sucesso|fechad|aceite|aceit/.test(n)) return 'ganho'
  return 'em_andamento'
}

// Cache em memória da carga dinâmica (por processo).
let _cache = { ts: 0, map: null }
const TTL_MS = 60 * 60 * 1000 // 1h — fases do funil quase nunca mudam

/**
 * Carrega o mapa completo de status do Kommo (todos os pipelines).
 * Retorna um objeto { [statusId]: { name, categoria, pipeline_id, pipeline_name } }.
 * Faz merge com o KNOWN_STATUS (o dinâmico tem prioridade quando disponível).
 * Nunca lança — em qualquer falha devolve só o estático.
 */
export async function loadKommoStatusMap(env, { force = false } = {}) {
  const now = Date.now()
  if (!force && _cache.map && now - _cache.ts < TTL_MS) return _cache.map

  const base = (env?.KOMMO_BASE_URL || '').replace(/\/$/, '')
  const token = env?.KOMMO_ACCESS_TOKEN || ''

  // Base: estático (garante 142/143 mesmo sem Kommo).
  const merged = {}
  for (const [id, v] of Object.entries(KNOWN_STATUS)) {
    merged[id] = { name: v.name, categoria: v.categoria, pipeline_id: null, pipeline_name: null }
  }

  if (base && token) {
    try {
      const res = await fetch(`${base}/api/v4/leads/pipelines`, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      })
      if (res.ok) {
        const data = await res.json()
        const pipelines = data?._embedded?.pipelines || []
        for (const p of pipelines) {
          const statuses = p?._embedded?.statuses || []
          for (const s of statuses) {
            const id = Number(s?.id)
            if (!Number.isFinite(id)) continue
            merged[id] = {
              name: s?.name || KNOWN_STATUS[id]?.name || `Status ${id}`,
              categoria: categorizeStatus(id, s?.name),
              pipeline_id: Number(p?.id) || null,
              pipeline_name: p?.name || null,
            }
          }
        }
      } else {
        console.warn(`[kommoStatusMap] Kommo pipelines ${res.status} — usando mapa estático`)
      }
    } catch (e) {
      console.warn(`[kommoStatusMap] falha ao carregar pipelines: ${e.message} — usando mapa estático`)
    }
  }

  _cache = { ts: now, map: merged }
  return merged
}

/**
 * Resolve a fase de um lead a partir do status_id, usando um mapa já
 * carregado (ver loadKommoStatusMap). Sempre retorna um objeto — para
 * status desconhecido usa "Status <id>" e categoria 'em_andamento'.
 */
export function resolveFase(map, statusId) {
  if (statusId == null) {
    return { status_id: null, nome: null, categoria: null, perdido: false }
  }
  const id = Number(statusId)
  const entry = (map && map[id]) || KNOWN_STATUS[id] || null
  const nome = entry?.name || `Status ${id}`
  const categoria = entry?.categoria || categorizeStatus(id, entry?.name)
  return { status_id: id, nome, categoria, perdido: categoria === 'perdido' }
}
