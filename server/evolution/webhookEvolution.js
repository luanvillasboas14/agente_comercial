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
import { saveConversation } from '../historyStore.js'
import { getLeadIdByTelefone } from '../dadosClienteStore.js'
import { seenMessage, withSessionLock } from './concurrency.js'
import { findLeadByPhone } from '../kommoClient.js'
import { sendMessageWithNote } from '../whatsappSender.js'
import { generateExecutionId, saveExecution } from '../ai/executionTelemetry.js'

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

function getMessageId(payload) {
  const d = payload?.data || payload
  return d?.key?.id || d?.messageId || d?.id || null
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

async function flushSessionInner(env, sessionId) {
  const itens = await getMessages(env, sessionId)
  if (!itens.length) {
    console.log(`[Evolution][flush] ${sessionId} sem mensagens pendentes`)
    return null
  }
  await clearMessages(env, sessionId)
  const mensagemCompleta = itens.join(', ')
  const telefone = normalizeTelefone(sessionId)
  const executionId = generateExecutionId()
  const startedAt = new Date().toISOString()
  console.log(`[${executionId}] flush ${sessionId} → "${mensagemCompleta}"`)

  let out = null
  let idLead = null
  let sendResult = null
  let histResult = null
  try {
    out = await runAgent(env, { telefone, userMessage: mensagemCompleta, executionId })
    if (out.ok) {
      console.log(
        `[${executionId}] agent ok (${out.durationMs}ms, ${out.usage?.total_tokens} tok, tools=${out.toolCalls?.length || 0}): ${out.reply?.slice(0, 200)}`,
      )
    } else {
      console.error(`[${executionId}] agent erro:`, out.error)
    }

    if (out?.ok && out.reply) {
      try {
        const lookup = await findLeadByPhone(env, telefone)
        if (lookup.ok && lookup.lead) {
          idLead = lookup.lead.id
          console.log(`[${executionId}] kommo lead ${idLead} encontrado p/ ${telefone}`)
        } else if (!lookup.ok) {
          console.warn(`[${executionId}] kommo falha: ${lookup.error || lookup.status}`)
        } else {
          console.log(`[${executionId}] kommo nenhum lead p/ ${telefone}`)
        }
      } catch (err) {
        console.error(`[${executionId}] kommo exception:`, err.message)
      }
      if (idLead == null) {
        try { idLead = await getLeadIdByTelefone(env, telefone) } catch {}
      }

      try {
        sendResult = await sendMessageWithNote(env, {
          telefone,
          text: out.reply,
          leadId: idLead,
          executionId,
        })
        if (sendResult.ok) {
          console.log(`[${executionId}] whatsapp enviado ${sendResult.sent}/${sendResult.total} partes`)
        } else {
          console.error(`[${executionId}] whatsapp falha após ${sendResult.sent}/${sendResult.total}:`, sendResult.error)
        }
      } catch (err) {
        console.error(`[${executionId}] whatsapp exception:`, err.message)
      }

      try {
        histResult = await saveConversation(env, {
          telefone,
          userMessage: mensagemCompleta,
          botMessage: out.reply,
          messageType: 'conversation',
          idLead,
        })
        if (!histResult.ok) {
          const failed = histResult.steps.filter((s) => s.ok === false)
          console.warn(`[${executionId}] history falhas:`, JSON.stringify(failed))
        }
      } catch (err) {
        console.error(`[${executionId}] history exception:`, err.message)
      }
    }
  } catch (err) {
    console.error(`[${executionId}] agent exception:`, err.message)
  }

  saveExecution(env, {
    id: executionId,
    timestamp: startedAt,
    userMessage: mensagemCompleta,
    model: out?.model || null,
    steps: buildSteps({ sendResult, histResult, idLead }),
    toolCalls: out?.toolCalls || [],
    response: out?.ok ? out.reply : null,
    error: out?.ok ? null : out?.error || 'runAgent retornou null',
    totalDurationMs: out?.durationMs || 0,
    usage: out?.usage || {},
    telefone,
    leadId: idLead,
    origem: 'evolution',
  }).then((r) => {
    if (!r.ok) console.warn(`[${executionId}] saveExecution falhou: ${r.error}`)
  }).catch((err) => console.error(`[${executionId}] saveExecution exception:`, err.message))

  return out
}

/**
 * Converte o resultado de envio/histórico em "steps" (mesmo conceito do
 * executionStore/ExecutionViewer) para debugar rapidamente o que aconteceu
 * depois que o agente respondeu.
 */
function buildSteps({ sendResult, histResult, idLead }) {
  const steps = []
  if (idLead != null) steps.push({ tool: 'kommo.findLeadByPhone', result: { leadId: idLead } })
  if (sendResult) {
    steps.push({
      tool: 'whatsapp.sendMessageWithNote',
      result: {
        ok: sendResult.ok,
        sent: sendResult.sent,
        total: sendResult.total,
        error: sendResult.error || null,
      },
    })
  }
  if (histResult) {
    const failed = (histResult.steps || []).filter((s) => s.ok === false).map((s) => s.step || 'step')
    steps.push({
      tool: 'history.saveConversation',
      result: {
        ok: histResult.ok,
        failedSubsteps: failed,
      },
    })
  }
  return steps
}

function flushSession(env, sessionId) {
  return withSessionLock(sessionId, () => flushSessionInner(env, sessionId))
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

    const messageId = getMessageId(payload)
    if (seenMessage(messageId)) {
      console.log(`[Evolution] duplicado ignorado (${messageId}) ${sessionId}`)
      res.status(200).json({ ok: true, skipped: 'duplicate', messageId })
      return
    }

    res.status(200).json({ ok: true, accepted: true, messageType, sessionId, messageId })

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
