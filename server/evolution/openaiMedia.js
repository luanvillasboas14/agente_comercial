/**
 * OpenAI helpers: transcrição de áudio (Whisper) e análise de imagem (Vision).
 * Usa fetch nativo do Node (≥18) — sem dependências extras.
 *
 * Áudio  → POST /v1/audio/transcriptions (whisper-1), input multipart.
 * Imagem → POST /v1/chat/completions     (gpt-4o-mini), content image_url data-URL.
 */

const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
const CHAT_URL = 'https://api.openai.com/v1/chat/completions'

const DEFAULT_IMAGE_PROMPT = 'Analise essa imagem e resuma pra mim o que ela é'

function b64ToBuffer(b64) {
  if (!b64 || typeof b64 !== 'string') throw new Error('Base64 ausente ou inválido')
  const clean = b64.replace(/^data:[^;]+;base64,/, '')
  return Buffer.from(clean, 'base64')
}

function requireApiKey(env) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  return apiKey
}

export async function transcribeAudioBase64(env, b64, opts = {}) {
  const apiKey = requireApiKey(env)
  const buf = b64ToBuffer(b64)
  const model = opts.model || env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1'
  const filename = opts.filename || 'file.ogg'
  const mimeType = opts.mimeType || 'audio/ogg'

  const form = new FormData()
  form.append('file', new Blob([buf], { type: mimeType }), filename)
  form.append('model', model)
  if (opts.language) form.append('language', opts.language)

  const res = await fetch(TRANSCRIBE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI transcribe ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const text = typeof data?.text === 'string' ? data.text.trim() : ''
  return text
}

export async function analyzeImageBase64(env, b64, opts = {}) {
  const apiKey = requireApiKey(env)
  const model = opts.model || env.OPENAI_VISION_MODEL || 'gpt-4o-mini'
  const prompt = opts.prompt || DEFAULT_IMAGE_PROMPT
  const mimeType = opts.mimeType || 'image/png'

  const clean = String(b64 || '').replace(/^data:[^;]+;base64,/, '')
  if (!clean) throw new Error('Imagem base64 ausente')
  const dataUrl = `data:${mimeType};base64,${clean}`

  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      max_tokens: 500,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI vision ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content.map((p) => p?.text || '').join(' ').trim()
  }
  return ''
}
