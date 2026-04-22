/**
 * Tool "localizacao" — espelha o subfluxo N8N (geocode + polo_loc + Haversine + Distance Matrix).
 * Requer: GOOGLE_MAPS_API_KEY, SUPABASE_URL, SUPABASE_KEY (mesmo projeto da tabela polo_loc).
 */

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

function num(v) {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v)
  return Number.isFinite(n) ? n : null
}

async function googleGeocode(address, apiKey) {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
  url.searchParams.set('address', address)
  url.searchParams.set('region', 'br')
  url.searchParams.set('language', 'pt-BR')
  url.searchParams.set('key', apiKey)
  const res = await fetch(url)
  const data = await res.json()
  if (!data.results?.length) {
    return { error: data.error_message || 'Endereço ou CEP não encontrado', raw: data }
  }
  const first = data.results[0]
  const loc = first.geometry?.location
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
    return { error: 'Resposta do Geocoding não contém coordenadas válidas', raw: data }
  }
  return {
    origem: {
      lat: loc.lat,
      lng: loc.lng,
      endereco_formatado: first.formatted_address || null,
      place_id: first.place_id || null,
    },
  }
}

async function fetchPolos(supabaseUrl, supabaseKey, limit = 2000) {
  const q = [
    'select=id,nome,endereco,latitude,longitude,rua',
    'order=id.asc',
    `limit=${limit}`,
  ].join('&')
  const res = await fetch(`${supabaseUrl}/rest/v1/polo_loc?${q}`, {
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${supabaseKey}`,
    },
  })
  if (!res.ok) {
    const t = await res.text()
    throw new Error(`Supabase polo_loc ${res.status}: ${t.slice(0, 200)}`)
  }
  const rows = await res.json()
  return Array.isArray(rows) ? rows : []
}

async function googleDistanceMatrix(origLat, origLng, polos, apiKey, mode) {
  const origins = `${origLat},${origLng}`
  const destinations = polos.map((p) => `${num(p.latitude)},${num(p.longitude)}`).join('|')
  const url = new URL('https://maps.googleapis.com/maps/api/distancematrix/json')
  url.searchParams.set('origins', origins)
  url.searchParams.set('destinations', destinations)
  url.searchParams.set('mode', mode)
  url.searchParams.set('region', 'br')
  url.searchParams.set('language', 'pt-BR')
  url.searchParams.set('key', apiKey)
  const res = await fetch(url)
  return res.json()
}

function pickBestFromMatrix(matrixJson, polos, originFormatted, travelMode = 'transit') {
  if (!matrixJson?.rows?.length || !matrixJson.rows[0]?.elements) {
    return { error: 'Formato inválido da resposta Distance Matrix', raw: matrixJson }
  }
  const elements = matrixJson.rows[0].elements
  const destAddrs = matrixJson.destination_addresses || []
  const originAddr = matrixJson.origin_addresses?.[0] || originFormatted || 'Origem'

  const candidatos = []
  for (let i = 0; i < elements.length; i++) {
    const e = elements[i]
    if (e.status === 'OK' && e.duration && e.distance) {
      const polo = polos[i] || {}
      const destino = destAddrs[i] || polo.endereco || ''
      candidatos.push({
        polo,
        destino_google: destino,
        duracao_segundos: e.duration.value,
        duracao_texto: e.duration.text,
        distancia_metros: e.distance.value,
        distancia_texto: e.distance.text,
      })
    }
  }
  if (!candidatos.length) {
    return { error: 'Nenhum trajeto com status OK no Distance Matrix', raw: matrixJson }
  }
  candidatos.sort((a, b) => a.duracao_segundos - b.duracao_segundos)
  const best = candidatos[0]
  const p = best.polo
  const nome = p.nome || 'Polo'
  const rua = p.rua || p.endereco || best.destino_google
  const origemParam = encodeURIComponent(originAddr)
  const destinoParam = encodeURIComponent(best.destino_google)
  const mode = travelMode === 'driving' ? 'driving' : 'transit'
  const linkRota = `https://www.google.com/maps/dir/?api=1&origin=${origemParam}&destination=${destinoParam}&travelmode=${mode}`

  return {
    polo_mais_proximo: nome,
    rua_polo_mais_proximo: rua,
    tempo_polo_mais_proximo: best.duracao_texto,
    distancia_texto: best.distancia_texto,
    link_google: linkRota,
    destino_google: best.destino_google,
  }
}

/**
 * @param {Record<string, string>} env
 * @param {{ localizacao?: string, telefone?: string }} body — telefone reservado (N8N passa mas não usa no fluxo)
 */
export async function runNearestPolo(env, body) {
  const mapsKey = env.GOOGLE_MAPS_API_KEY || env.VITE_GOOGLE_MAPS_API_KEY
  const supabaseUrl = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const supabaseKey = env.SUPABASE_KEY || env.VITE_SUPABASE_KEY

  const localizacao = String(body?.localizacao || body?.localização || '').trim()
  if (!localizacao) {
    return { ok: false, error: 'Parâmetro localizacao é obrigatório (cidade, rua e número ou CEP).' }
  }
  if (!mapsKey) {
    return { ok: false, error: 'GOOGLE_MAPS_API_KEY não configurada no servidor.' }
  }
  if (!supabaseUrl || !supabaseKey) {
    return { ok: false, error: 'SUPABASE_URL / SUPABASE_KEY não configurados.' }
  }

  const geo = await googleGeocode(localizacao, mapsKey)
  if (geo.error) {
    return { ok: false, error: geo.error }
  }
  const { origem } = geo

  let polos
  try {
    polos = await fetchPolos(supabaseUrl, supabaseKey)
  } catch (e) {
    return { ok: false, error: e.message }
  }

  const comCoord = polos.filter((p) => num(p.latitude) != null && num(p.longitude) != null)
  if (!comCoord.length) {
    return { ok: false, error: 'Nenhum polo com latitude/longitude na base.' }
  }

  const scored = comCoord.map((p) => ({
    ...p,
    distancia_km: haversineKm(origem.lat, origem.lng, num(p.latitude), num(p.longitude)),
  }))
  scored.sort((a, b) => a.distancia_km - b.distancia_km)
  const top2 = scored.slice(0, 2)

  let modeUsed = 'transit'
  let matrix = await googleDistanceMatrix(origem.lat, origem.lng, top2, mapsKey, modeUsed)
  let best = pickBestFromMatrix(matrix, top2, origem.endereco_formatado, modeUsed)

  if (best.error) {
    modeUsed = 'driving'
    matrix = await googleDistanceMatrix(origem.lat, origem.lng, top2, mapsKey, modeUsed)
    best = pickBestFromMatrix(matrix, top2, origem.endereco_formatado, modeUsed)
  }

  if (best.error) {
    return { ok: false, error: best.error, origem }
  }

  return {
    ok: true,
    origem_endereco: origem.endereco_formatado,
    polo_mais_proximo: best.polo_mais_proximo,
    rua_do_polo: best.rua_polo_mais_proximo,
    tempo_estimado: best.tempo_polo_mais_proximo,
    distancia: best.distancia_texto,
    link_rota_google: best.link_google,
    modo_transporte: modeUsed === 'transit' ? 'transporte público' : 'carro (transit indisponível para estes destinos)',
  }
}
