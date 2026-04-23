/**
 * Versão server-side do loop do Playground: recebe a mensagem já “juntada” do
 * lead + telefone, monta o system (APAGAR.txt + override), injeta as últimas N
 * mensagens do n8n_chat_histories como turnos anteriores e roda até 5 rodadas
 * de tool_calls.
 */

import { loadPrompts, buildSystemMessage } from './promptsLoader.js'
import { TOOL_DEFINITIONS } from './toolDefinitions.js'
import { buildToolExecutors } from './toolExecutorsServer.js'
import { runBuscarHistorico } from '../memoryTool.js'
import { generateExecutionId } from './executionTelemetry.js'

const MAX_TOOL_ROUNDS = 5
const CHAT_URL = 'https://api.openai.com/v1/chat/completions'

function resolveModel(env) {
  return env.OPENAI_AGENT_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini'
}

function resolveHistoryLimit(env) {
  const n = Number(env.AGENT_HISTORY_CONTEXT || 8)
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 8
}

async function loadRecentHistoryMessages(env, telefone) {
  if (!telefone) return []
  try {
    const out = await runBuscarHistorico(env, { telefone, limit: resolveHistoryLimit(env) })
    if (!out.ok || !Array.isArray(out.mensagens)) return []
    return out.mensagens
      .map((m) => {
        if (m.role === 'lead') return { role: 'user', content: m.content }
        if (m.role === 'assistente') return { role: 'assistant', content: m.content }
        return null
      })
      .filter(Boolean)
  } catch (err) {
    console.warn('[agentRunner] histórico indisponível:', err.message)
    return []
  }
}

async function callOpenAI(env, apiMessages) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  const res = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: resolveModel(env),
      messages: apiMessages,
      tools: TOOL_DEFINITIONS,
      temperature: 0.7,
      max_tokens: 2048,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json()
}

async function executeToolCalls(executors, toolCalls, trace) {
  const results = []
  for (const tc of toolCalls) {
    const fn = tc.function
    const step = { tool: fn.name, args: {}, result: null, error: null, durationMs: 0 }
    const executor = executors[fn.name]
    if (!executor) {
      step.error = `Ferramenta "${fn.name}" não disponível`
      trace.push(step)
      results.push({ tool_call_id: tc.id, role: 'tool', content: step.error })
      continue
    }
    const t0 = Date.now()
    try {
      const args = JSON.parse(fn.arguments || '{}')
      step.args = args
      const result = await executor(args)
      step.result = result || 'Nenhum resultado encontrado na base.'
      step.durationMs = Date.now() - t0
      results.push({ tool_call_id: tc.id, role: 'tool', content: String(step.result) })
    } catch (e) {
      step.error = e.message
      step.durationMs = Date.now() - t0
      results.push({ tool_call_id: tc.id, role: 'tool', content: `Erro: ${e.message}` })
    }
    trace.push(step)
  }
  return results
}

/**
 * @param {object} env    process.env
 * @param {object} input  { telefone, userMessage, pushName, executionId? }
 * @returns { ok, reply, toolCalls[], usage, durationMs, executionId, model }
 */
export async function runAgent(env, input) {
  const t0 = Date.now()
  const telefone = input?.telefone || ''
  const userMessage = (input?.userMessage || '').trim()
  const executionId = input?.executionId || generateExecutionId()
  const model = resolveModel(env)
  if (!userMessage) return { ok: false, error: 'Mensagem vazia', executionId, model }

  const [prompts, historyMessages] = await Promise.all([
    loadPrompts(),
    loadRecentHistoryMessages(env, telefone),
  ])

  const systemMessage = buildSystemMessage(prompts)
  const contextPreamble =
    telefone
      ? `Contexto do atendimento:\n- Telefone do lead: ${telefone}${input?.pushName ? `\n- Nome (pushName): ${input.pushName}` : ''}`
      : ''

  const apiMessages = [
    { role: 'system', content: systemMessage },
    ...(contextPreamble ? [{ role: 'system', content: contextPreamble }] : []),
    ...historyMessages,
    { role: 'user', content: userMessage },
  ]

  const executors = buildToolExecutors(env)
  const toolTrace = []
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

  try {
    let round = 0
    while (round < MAX_TOOL_ROUNDS) {
      const data = await callOpenAI(env, apiMessages)
      const choice = data.choices?.[0]
      const msg = choice?.message
      if (!msg) throw new Error('Sem resposta da API')

      if (data.usage) {
        usage.prompt_tokens += data.usage.prompt_tokens || 0
        usage.completion_tokens += data.usage.completion_tokens || 0
        usage.total_tokens += data.usage.total_tokens || 0
      }

      if (choice.finish_reason === 'tool_calls' || (msg.tool_calls && msg.tool_calls.length > 0)) {
        apiMessages.push(msg)
        const toolResults = await executeToolCalls(executors, msg.tool_calls, toolTrace)
        apiMessages.push(...toolResults)
        round++
        continue
      }

      const reply = msg.content || 'Sem resposta.'
      return {
        ok: true,
        reply,
        toolCalls: toolTrace,
        usage,
        durationMs: Date.now() - t0,
        historyLoaded: historyMessages.length,
        executionId,
        model,
      }
    }
    return {
      ok: false,
      error: 'Limite de rodadas de tools atingido.',
      toolCalls: toolTrace,
      usage,
      durationMs: Date.now() - t0,
      executionId,
      model,
    }
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      toolCalls: toolTrace,
      usage,
      durationMs: Date.now() - t0,
      executionId,
      model,
    }
  }
}
