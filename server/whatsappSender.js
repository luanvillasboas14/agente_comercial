/**
 * Envio de mensagens pela WhatsApp Cloud API (Meta / WACA).
 * Espelha o fluxo do `envio mensagem.txt` do N8N:
 *
 *   texto da IA → split em partes (≤1000 chars, quebra inteligente)
 *     para cada parte:
 *       • POST /<phone_number_id>/messages (Cloud API)
 *       • POST /api/v4/leads/{id}/notes    (Kommo, com "<texto> - <execution_id>")
 *       • wait 1 segundo
 *
 * Env:
 *   WHATSAPP_PHONE_NUMBER_ID   ex: 440327379171310
 *   WHATSAPP_ACCESS_TOKEN      token do Meta Business (WACA)
 *   WHATSAPP_API_VERSION       opcional, default v19.0
 *   WHATSAPP_MAX_CHARS         opcional, default 1000 (mesmo do n8n)
 *   WHATSAPP_CHUNK_DELAY_MS    opcional, default 1000
 */

import crypto from 'crypto'
import { createLeadNote } from './kommoClient.js'

function getConfig(env) {
  const maxChars = Number(env.WHATSAPP_MAX_CHARS)
  const chunkDelay = Number(env.WHATSAPP_CHUNK_DELAY_MS)
  return {
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v19.0',
    maxChars: Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1000,
    chunkDelayMs: Number.isFinite(chunkDelay) && chunkDelay >= 0 ? Math.floor(chunkDelay) : 1000,
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)))
}

function digitsOnly(input) {
  return String(input || '').split('@')[0].replace(/[^0-9]/g, '')
}

/**
 * Split inteligente — porta do `Code in JavaScript1` do N8N (envio mensagem.txt).
 * Quebra o texto em partes de até `maxLen` chars preferindo separadores naturais.
 */
export function splitMessage(input, maxLen = 1000) {
  const s = String(input || '').trim()
  if (!s) return []
  if (s.length <= maxLen) return [s]

  const chunks = []
  let i = 0

  const pickCut = (window) => {
    const prefer = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' ']
    for (const sep of prefer) {
      const idx = window.lastIndexOf(sep)
      if (idx >= Math.min(200, Math.floor(maxLen * 0.4))) {
        return idx + (sep.length === 2 ? 1 : 0)
      }
    }
    const lastSpace = window.lastIndexOf(' ')
    if (lastSpace > 20) return lastSpace
    return window.length
  }

  while (i < s.length) {
    if (s.length - i <= maxLen) {
      chunks.push(s.slice(i).trim())
      break
    }
    const window = s.slice(i, i + maxLen)
    let cut = pickCut(window)
    let piece = window.slice(0, cut).trim()
    if (!piece) {
      piece = window.slice(0, maxLen).trim()
      cut = maxLen
    }
    chunks.push(piece)
    i += cut
    while (s[i] === ' ' || s[i] === '\n') i++
  }
  return chunks.filter(Boolean)
}

/**
 * Envia UM pedaço via WhatsApp Cloud API.
 * @returns { ok, status?, messageId?, code?, error? }
 */
export async function sendText(env, { to, text }) {
  const cfg = getConfig(env)
  if (!cfg.phoneNumberId || !cfg.accessToken) {
    return {
      ok: false,
      code: 'WHATSAPP_NOT_CONFIGURED',
      error: 'Configure WHATSAPP_PHONE_NUMBER_ID e WHATSAPP_ACCESS_TOKEN.',
    }
  }
  const recipient = digitsOnly(to)
  if (!recipient) return { ok: false, code: 'MISSING_TO', error: 'destinatário vazio' }
  const body = String(text || '')
  if (!body.trim()) return { ok: false, code: 'EMPTY_BODY', error: 'texto vazio' }

  const url = `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/messages`
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.accessToken}`,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
        type: 'text',
        text: { body, preview_url: false },
      }),
    })
    const raw = await res.text()
    let data = null
    try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
    if (!res.ok) {
      return {
        ok: false,
        code: 'WHATSAPP_SEND_FAILED',
        status: res.status,
        error: typeof raw === 'string' ? raw.slice(0, 500) : 'unknown',
      }
    }
    const messageId = data?.messages?.[0]?.id || null
    return { ok: true, status: res.status, messageId }
  } catch (e) {
    return { ok: false, code: 'WHATSAPP_FETCH_FAILED', error: e.message }
  }
}

/**
 * Orquestra split → envio → nota Kommo → espera por cada parte.
 *
 * @param {Record<string,string>} env
 * @param {object} params
 * @param {string} params.telefone      destinatário (aceita JID ou só dígitos)
 * @param {string} params.text          resposta completa da IA (será split)
 * @param {number|string} [params.leadId] id do lead no Kommo (opcional — se faltar, pula notas)
 * @param {string} [params.executionId] id único de execução; gerado se não informado
 * @returns { ok, executionId, total, sent, steps[], error? }
 */
export async function sendMessageWithNote(env, { telefone, text, leadId, executionId }) {
  const cfg = getConfig(env)
  const parts = splitMessage(text, cfg.maxChars)
  if (!parts.length) {
    return { ok: false, code: 'EMPTY_BODY', error: 'texto vazio', total: 0, sent: 0, steps: [] }
  }
  const execId = executionId || crypto.randomUUID()
  const steps = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const sent = await sendText(env, { to: telefone, text: part })
    steps.push({ step: 'send', index: i + 1, total: parts.length, ...sent })
    if (!sent.ok) {
      return {
        ok: false,
        executionId: execId,
        sent: i,
        total: parts.length,
        steps,
        error: sent.error || sent.code,
      }
    }

    if (leadId != null && leadId !== '') {
      const note = await createLeadNote(env, leadId, `${part} - ${execId}`)
      steps.push({ step: 'note', index: i + 1, total: parts.length, ...note })
      if (!note.ok) {
        console.warn(`[WhatsApp][kommo-note] falha parte ${i + 1}: ${note.error || note.status}`)
      }
    } else {
      steps.push({ step: 'note', index: i + 1, skipped: true, reason: 'no_lead_id' })
    }

    if (i < parts.length - 1 && cfg.chunkDelayMs > 0) {
      await sleep(cfg.chunkDelayMs)
    }
  }

  return { ok: true, executionId: execId, total: parts.length, sent: parts.length, steps }
}
