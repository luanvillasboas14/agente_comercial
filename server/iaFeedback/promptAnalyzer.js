/**
 * promptAnalyzer — chama o o3-mini para propor mudanças cirúrgicas no AGENT_RULES_TEXT
 * com base em violações frequentes detectadas pelo Feedback IA.
 */

import { resolveModel } from '../ai/modelRegistry.js'

// ─── HTTP com timeout ─────────────────────────────────────────────────────────

async function fetchWithTimeout(url, options = {}, timeoutMs = 180_000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return fetch(url, options)
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (e) {
    if (e?.name === 'AbortError') {
      throw new Error(`[analyzer/openai] Timeout: chamada ao OpenAI não respondeu em ${timeoutMs}ms`)
    }
    throw e
  } finally {
    clearTimeout(t)
  }
}

// ─── Extração do trecho da regra ─────────────────────────────────────────────

/**
 * Extrai o trecho de texto da regra N no agent_rules_text.
 * Funciona com regras numeradas no padrão "{N}. " no início de uma linha.
 */
function extractRuleText(agentRulesText, regraAlvo) {
  const match = regraAlvo.match(/(\d+)$/)
  if (!match) throw new Error(`[analyzer/extract] regra-alvo inválida — não encontrou número: "${regraAlvo}"`)
  const n = parseInt(match[1], 10)

  const lines = agentRulesText.split('\n')
  let startIdx = -1
  let endIdx = -1

  for (let i = 0; i < lines.length; i++) {
    if (new RegExp(`^${n}\\.\\s`).test(lines[i])) {
      startIdx = i
    } else if (startIdx >= 0 && /^\d+\.\s/.test(lines[i])) {
      endIdx = i
      break
    }
  }

  if (startIdx < 0) {
    throw new Error(`[analyzer/extract] regra-alvo não encontrada no prompt ativo: ${regraAlvo}`)
  }

  const ruleLines = endIdx >= 0 ? lines.slice(startIdx, endIdx) : lines.slice(startIdx)
  // Remove linhas vazias do final
  while (ruleLines.length > 0 && !ruleLines[ruleLines.length - 1].trim()) ruleLines.pop()
  return ruleLines.join('\n')
}

/**
 * Verifica se um trecho de texto está dentro de uma seção <!-- IMUTÁVEL -->.
 */
function isInImutableSection(agentRulesText, trecho) {
  const regex = /<!--\s*IMUTÁVEL\s*-->([\s\S]*?)<!--\s*\/IMUTÁVEL\s*-->/g
  let m
  while ((m = regex.exec(agentRulesText)) !== null) {
    if (m[1].includes(trecho)) return true
  }
  return false
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `Você é um engenheiro de prompts especializado em corrigir regras de agentes conversacionais.

CONTEXTO:
Um agente de WhatsApp opera com um conjunto de regras numeradas (Regra 1 a Regra 18). Avaliações automáticas detectaram violações repetidas de uma regra específica. Sua tarefa é propor uma modificação cirúrgica nessa regra para reduzir essas violações.

ENTRADA QUE VOCÊ RECEBE:
1. Texto completo do AGENT_RULES_TEXT atual (todas as regras).
2. A REGRA-ALVO específica (ex: "Regra 3") com seu texto exato.
3. Lista das violações dessa regra na janela analisada, cada uma com execution_id, citação literal, severidade e descrição.

Trechos entre marcadores <!-- IMUTÁVEL --> e <!-- /IMUTÁVEL --> NÃO podem ser modificados — são a constituição do agente.

REGRAS DA SUA PROPOSTA:
1. Cirurgia, não cirurgia plástica: modifique o mínimo necessário. Prefira adicionar uma exceção curta a reescrever a regra inteira.
2. Mantenha o tom: o agente fala em português brasileiro informal-profissional. Não use jargão técnico nem linguagem corporativa.
3. Consolide quando possível: se a regra já está inchada (>200 palavras), considere remover redundâncias em vez de adicionar texto.
4. Não invente exceções genéricas: cada exceção deve estar ancorada nas violações reais que você recebeu. Cite a evidência na justificativa.
5. Detecte conflitos: se sua mudança puder entrar em conflito com outra regra do conjunto, sinalize em conflitos_potenciais.
6. trecho_antes DEVE ser uma cópia LITERAL e EXATA de um trecho contínuo do prompt atual — não parafraseie, não resuma, não corte caracteres. O sistema vai aplicar string.replace(trecho_antes, trecho_depois) e falha se o trecho não casar exatamente.
7. Se as violações sugerirem que o avaliador está classificando incorretamente (e não que a regra está errada), retorne tipo_mudanca="nenhuma" e explique na justificativa.

SAÍDA: JSON estrito, somente o objeto, sem markdown nem comentários:

{
  "regra_alvo": "Regra X",
  "tipo_mudanca": "ajuste" | "consolidacao" | "novo_exemplo" | "remocao" | "nenhuma",
  "trecho_antes": "<texto literal copiado do prompt atual>",
  "trecho_depois": "<texto modificado, ou vazio se tipo_mudanca='nenhuma'>",
  "justificativa": "<2-4 frases>",
  "conflitos_potenciais": "<texto descrevendo conflito ou null>"
}`

function buildUserMessage({ agentRulesText, versao, regraAlvo, ruleText, exemplos, totalViolacoes }) {
  const exemploLines = exemplos.map((ex, i) => {
    return `#${i + 1}. execution_id: ${ex.execution_id || 'n/a'} | severidade: ${ex.severidade}
  citação: "${ex.citacao}"
  descrição: ${ex.descricao}`
  }).join('\n\n')

  return `PROMPT INTEIRO ATUAL (versão ${versao}):

---
${agentRulesText}
---

REGRA-ALVO: ${regraAlvo}

TEXTO LITERAL DA REGRA-ALVO:

---
${ruleText}
---

VIOLAÇÕES OBSERVADAS (últimas ${exemplos.length} exemplos na janela após a versão atual):

${exemploLines || '(nenhum exemplo disponível)'}

Total: ${totalViolacoes} violações dessa regra na janela.

Retorne sua proposta no formato JSON especificado.`
}

// ─── Função principal ─────────────────────────────────────────────────────────

/**
 * Analisa uma regra com base no ranking de violações e propõe uma mudança.
 *
 * @param {Record<string,string>} env
 * @param {{ regraAlvo: string, ranking: object, activeVersion: object }} opts
 * @returns {Promise<object>} Objeto da proposta validado
 */
export async function analyzeRule(env, { regraAlvo, ranking, activeVersion }) {
  const agentRulesText = activeVersion.agent_rules_text

  // 1. Extrai trecho da regra
  const ruleText = extractRuleText(agentRulesText, regraAlvo)

  // 2. Verifica imutabilidade
  if (isInImutableSection(agentRulesText, ruleText)) {
    return {
      regra_alvo: regraAlvo,
      tipo_mudanca: 'nenhuma',
      trecho_antes: ruleText,
      trecho_depois: '',
      justificativa: 'Regra dentro de seção imutável — não permitido modificar via analisador.',
      conflitos_potenciais: null,
    }
  }

  // 3. Encontra exemplos no ranking
  const regraData = Array.isArray(ranking.ranking)
    ? ranking.ranking.find((r) => r.regra === regraAlvo)
    : null
  const exemplos = regraData?.exemplos ?? []
  const totalViolacoes = regraData?.count ?? 0

  // 4. Resolve modelo
  const model = resolveModel(env, 'prompt_optimizer')
  const key = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || ''
  if (!key) throw new Error('[analyzer/config] OPENAI_API_KEY não configurada')

  // 5. Chama o3-mini — sem temperature, sem max_tokens (usa max_completion_tokens se quiser)
  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildUserMessage({
          agentRulesText,
          versao: activeVersion.versao,
          regraAlvo,
          ruleText,
          exemplos,
          totalViolacoes,
        }),
      },
    ],
  }

  const timeoutMs = Number(env.PROMPT_OPTIMIZER_OPENAI_TIMEOUT_MS || 180_000)
  const res = await fetchWithTimeout(
    'https://api.openai.com/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
    },
    timeoutMs,
  )

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(
      `[analyzer/openai] HTTP ${res.status} (modelo=${model}): ${errText.slice(0, 400) || res.statusText}`,
    )
  }

  const data = await res.json()
  const content = String(data?.choices?.[0]?.message?.content || '').trim()

  // 6. Parse JSON
  let proposal
  try {
    proposal = JSON.parse(content)
  } catch (err) {
    const excerpt = content.slice(0, 300).replace(/\s+/g, ' ')
    console.error(`[analyzer/parser] Resposta o3-mini não é JSON válido. Excerpt: "${excerpt}"`)
    throw new Error(`[analyzer/parser] Falha ao parsear resposta do o3-mini: ${err.message}`)
  }

  // 7. Valida estrutura
  if (!proposal.regra_alvo || !proposal.tipo_mudanca) {
    throw new Error(
      `[analyzer/validation] Campos obrigatórios faltando: regra_alvo=${JSON.stringify(proposal.regra_alvo)}, tipo_mudanca=${JSON.stringify(proposal.tipo_mudanca)}`,
    )
  }

  const TIPOS_VALIDOS = new Set(['ajuste', 'consolidacao', 'novo_exemplo', 'remocao', 'nenhuma'])
  if (!TIPOS_VALIDOS.has(proposal.tipo_mudanca)) {
    throw new Error(`[analyzer/validation] tipo_mudanca inválido: "${proposal.tipo_mudanca}"`)
  }

  if (proposal.tipo_mudanca !== 'nenhuma') {
    if (!proposal.trecho_antes || !agentRulesText.includes(proposal.trecho_antes)) {
      console.error(
        `[analyzer/validation] trecho_antes não encontrado no prompt ativo. Modelo retornou: "${String(proposal.trecho_antes || '').slice(0, 200)}"`,
      )
      throw new Error(
        '[analyzer/validation] trecho_antes não encontrado literalmente no prompt ativo. O modelo deve copiar trecho exato.',
      )
    }
  }

  return proposal
}
