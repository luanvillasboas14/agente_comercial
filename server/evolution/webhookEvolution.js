/**
 * Webhook Evolution API — equivalente ao fluxo "Reddis IA.txt" do n8n.
 *
 * 1) Classifica o messageType (extendedTextMessage, conversation, audioMessage,
 *    imageMessage, buttonMessage).
 * 2) Áudio  → transcrição (Whisper).
 * 3) Imagem → análise (gpt-4o-mini Vision). Se tiver caption, concatena.
 * 4) Botão  → usa o texto do botão.
 * 5) Empurra a string resultante no buffer Redis (chave = telefone/JID).
 * 6) Reagenda debounce (default 20s). Quando o tempo acaba sem novidades,
 *    lê a lista, junta com ", ", limpa o Redis e chama o runAgent.
 *
 * Respostas reais para o lead (Evolution /message/sendText) ficam fora desse
 * módulo — você liga depois. Aqui a gente só loga + retorna a reply.
 */

import { pushMessage, getMessages, clearMessages } from './messageBuffer.js'
import { scheduleFlush } from './debouncer.js'
import { transcribeAudioBase64, analyzeImageBase64 } from './openaiMedia.js'
import { runAgent } from '../ai/agentRunner.js'

function getBody(req) {
  const body = req.body || {}
  return body.body ? body.body : body
}

function getMessageType(payload) {
  return (
    payload?.data?.messageType ||
    payload?.messageType ||
    null
  )
}

function getSessionId(payload) {
  const d = payload?.data || payload
  return (
    d?.key?.remoteJid ||
    d?.remoteJid ||
    d?.sessionId ||
    null
  )
}

function normalizeTelefone(sessionId) {
  if (!sessionId) return ''
  return String(sessionId).split('@')[0].replace(/[^0-9]/g, '')
}

function getPushName(payload) {
  const d = payload?.data || payload
  return d?.pushName || d?.pushname || ''
}

function getBase64(payload) {
  const d = payload?.data || payload
  return d?.message?.base64 || d?.message?.mediaBase64 || null
}

function getImageCaption(payload) {
  const d = payload?.data || payload
  return d?.message?.imageMessage?.caption || ''
}

function getTextContent(payload) {
  const d = payload?.data || payload
  const m = d?.message || {}
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.buttonText ||
    ''
  )
}

function authOk(env, req) {
  const expected = env.EVOLUTION_WEBHOOK_TOKEN
  if (!expected) return true
  const provided =
    req.headers['x-webhook-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query?.token
  return provided === expected
}

async function extractMessageText(env, payload, messageType) {
  switch (messageType) {
    case 'conversation':
    case 'extendedTextMessage':
      return getTextContent(payload)

    case 'buttonMessage':
    case 'buttonsResponseMessage':
    case 'templateButtonReplyMessage':
    case 'listResponseMessage':
      return getTextContent(payload)

    case 'audioMessage': {
      const b64 = getBase64(payload)
      if (!b64) return ''
      return transcribeAudioBase64(env, b64, { filename: 'file.ogg', mimeType: 'audio/ogg' })
    }

    case 'imageMessage': {
      const b64 = getBase64(payload)
      if (!b64) return ''
      const caption = getImageCaption(payload).trim()
      const analysis = await analyzeImageBase64(env, b64, { mimeType: 'image/png' })
      const clean = analysis.replace(/\n/g, ' ').replace(/['"]/g, '').trim()
      return caption ? `${caption}, ${clean}` : clean
    }

    default:
      return getTextContent(payload)
  }
}

async function flushSession(env, sessionId) {
  const itens = await getMessages(env, sessionId)
  if (!itens.length) {
    console.log(`[Evolution][flush] ${sessionId} sem mensagens pendentes`)
    return null
  }
  await clearMessages(env, sessionId)
  const mensagemCompleta = itens.join(', ')
  const telefone = normalizeTelefone(sessionId)
  console.log(`[Evolution][flush] ${sessionId} → "${mensagemCompleta}"`)
  try {
    const out = await runAgent(env, { telefone, userMessage: mensagemCompleta })
    if (out.ok) {
      console.log(`[Evolution][agent] reply (${out.durationMs}ms, ${out.usage?.total_tokens} tok): ${out.reply?.slice(0, 200)}`)
    } else {
      console.error(`[Evolution][agent] erro:`, out.error)
    }
    return out
  } catch (err) {
    console.error('[Evolution][agent] exception:', err.message)
    return null
  }
}

export function makeEvolutionWebhookHandler(env) {
  return async function handler(req, res) {
    if (!authOk(env, req)) {
      res.status(401).json({ ok: false, error: 'invalid token' })
      return
    }
    const payload = getBody(req)
    const messageType = getMessageType(payload)
    const sessionId = getSessionId(payload)
    const pushName = getPushName(payload)

    if (!messageType || !sessionId) {
      res.status(200).json({ ok: true, skipped: 'missing_type_or_session' })
      return
    }
    if (payload?.data?.key?.fromMe) {
      res.status(200).json({ ok: true, skipped: 'fromMe' })
      return
    }

    res.status(200).json({ ok: true, accepted: true, messageType, sessionId })

    setImmediate(async () => {
      try {
        const text = await extractMessageText(env, payload, messageType)
        const clean = String(text || '').trim()
        if (!clean) {
          console.warn(`[Evolution] ${messageType} sem conteúdo utilizável (${sessionId})`)
          return
        }
        console.log(`[Evolution] ${messageType} ← ${sessionId} (${pushName}): "${clean.slice(0, 140)}"`)
        await pushMessage(env, sessionId, clean)
        scheduleFlush(sessionId, (sid) => flushSession(env, sid), env)
      } catch (err) {
        console.error('[Evolution] processing error:', err.message)
      }
    })
  }
}
