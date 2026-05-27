/**
 * promptAnalyzer — chama o o3-mini para propor mudanças cirúrgicas no AGENT_RULES_TEXT
 * com base em violações frequentes detectadas pelo Feedback IA.
 *
 * Exporta:
 *   analyzeRule            — análise de uma única regra (fluxo original)
 *   runMultiViolationAnalyzer — análise de N violações selecionadas manualmente
 *   runAcertosAnalyzer     — análise de N falsos-positivos para reforçar comportamentos corretos
 */

import { resolveModel } from '../ai/modelRegistry.js'
import { fetchConversationsByFeedbackIds } from './violationsRanking.js'
import { getFeedbackSupabase } from './supabaseClient.js'

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
0. ANTES DE TUDO: identifique o SUBITEM exato da regra que está sendo violado.

   Regras complexas como 13 ou 14 têm vários subitens (a, b, c, d, e, f...). Cada subitem trata de um caso diferente. Violar 13c (a IA ofereceu grade sem ter) é completamente diferente de violar 13d (resposta a pedido do lead). Você DEVE:

   - Ler a CONVERSA COMPLETA dos exemplos (não só a citação) pra entender o contexto.
   - Identificar qual subitem específico (ex: 13c, 13f) está sendo violado.
   - O trecho_antes que você vai propor mudar DEVE pertencer a esse subitem específico. Não mude um subitem que não está sendo violado.
   - Iniciar a justificativa com "Subitem violado: <X>."

   Se você não conseguir identificar o subitem com certeza (ex: a citação é ambígua e a conversa não ajuda), retorne tipo_mudanca="nenhuma" com justificativa explicando a ambiguidade.

1. Cirurgia, não cirurgia plástica: modifique o mínimo necessário. Prefira adicionar uma exceção curta a reescrever a regra inteira.
2. Mantenha o tom: o agente fala em português brasileiro informal-profissional. Não use jargão técnico nem linguagem corporativa.
3. Consolide quando possível: se a regra já está inchada (>200 palavras), considere remover redundâncias em vez de adicionar texto.
4. Não invente exceções genéricas: cada exceção deve estar ancorada nas violações reais que você recebeu. Cite a evidência na justificativa.
5. Detecte conflitos: se sua mudança puder entrar em conflito com outra regra do conjunto, sinalize em conflitos_potenciais.
6. trecho_antes DEVE ser uma cópia LITERAL E EXATA de um trecho contínuo do prompt atual. Isso significa:
   - Copie caractere por caractere, incluindo TODOS os espaços, indentação, quebras de linha, pontuação e caracteres especiais.
   - NÃO reformate, NÃO consolide espaços em branco, NÃO troque quebras de linha por espaços, NÃO remova indentação.
   - NÃO adicione "..." ou comentários no trecho.
   - O sistema valida com agentRulesText.includes(trecho_antes) — se não casar caractere a caractere, a proposta é rejeitada.
   - Em caso de dúvida, copie um trecho MENOR e mais cirúrgico (uma frase só) ao invés de um trecho maior que pode ter formatação sutil.
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

function formatTurn(turn) {
  if (!turn || typeof turn !== 'object') return ''
  const from = String(turn.from || turn.role || '').toLowerCase()
  const text = String(turn.text || turn.content || '').slice(0, 500)
  const exec = turn.execution_id ? ` (EX-${turn.execution_id})` : ''
  const tools = Array.isArray(turn.tools) && turn.tools.length ? ` [tools: ${turn.tools.join(', ')}]` : ''
  const tag = from === 'lead' || from === 'user' ? 'LEAD'
    : from === 'ia' || from === 'assistant' ? 'IA'
    : from.toUpperCase() || 'MSG'
  return `${tag}${exec}${tools}: ${text}`
}

function formatConversa(conversa) {
  if (!Array.isArray(conversa) || conversa.length === 0) return '(conversa vazia ou indisponível)'
  return conversa.map(formatTurn).filter(Boolean).join('\n')
}

function buildUserMessage({
  agentRulesText, versao, regraAlvo, ruleText,
  exemplosComConversa, exemplosResumidos, conversasMap,
  totalViolacoes, instrucaoExtra,
}) {
  const blocosComConversa = exemplosComConversa.map((ex, i) => {
    const conversa = conversasMap.get(ex.feedback_id)
    return `### Exemplo ${i + 1} (severidade: ${ex.severidade}, execution_id: ${ex.execution_id || 'n/a'})

Citação do turno onde o avaliador detectou a violação:
"${ex.citacao}"

Descrição do avaliador:
${ex.descricao}

CONVERSA COMPLETA onde isso aconteceu (turnos em ordem cronológica):

${formatConversa(conversa)}`
  }).join('\n\n---\n\n')

  const blocoResumidos = exemplosResumidos.length === 0 ? '' : `

Exemplos adicionais (apenas citação, sem conversa completa):
${exemplosResumidos.map((ex, i) => `${i + 1}. [${ex.severidade}] execution_id=${ex.execution_id || 'n/a'} — "${ex.citacao}" — ${ex.descricao}`).join('\n')}`

  const blocoInstrucaoExtra = instrucaoExtra ? `

INSTRUÇÃO ADICIONAL DO ADMIN (você está sendo reanalisado porque a proposta anterior estava errada):
${instrucaoExtra}` : ''

  return `PROMPT INTEIRO ATUAL (versão ${versao}):

---
${agentRulesText}
---

REGRA-ALVO: ${regraAlvo}

TEXTO LITERAL DA REGRA-ALVO (esta regra pode ter vários subitens — a, b, c, d, e, f...; identifique EXATAMENTE qual subitem está sendo violado):

---
${ruleText}
---

VIOLAÇÕES OBSERVADAS — total na janela: ${totalViolacoes}. Abaixo, os exemplos mais relevantes (priorizados por severidade):

${blocosComConversa || '(nenhum exemplo disponível)'}${blocoResumidos}${blocoInstrucaoExtra}

Antes de responder, faça em silêncio:
1. Leia a CONVERSA COMPLETA dos exemplos com conversa. NÃO confie só na citação isolada — o contexto do turno anterior muda tudo.
2. Identifique exatamente QUAL SUBITEM da regra (ex: "13c" ou "13d" ou "13f") está sendo violado em cada exemplo.
3. Verifique se múltiplos exemplos violam subitens diferentes — se sim, escolha o subitem com mais ocorrências.
4. Só então decida o trecho_antes (cópia LITERAL do subitem ofendido) e o trecho_depois.

Na sua justificativa, INICIE indicando o subitem identificado. Ex: "Subitem violado: 13c. Os exemplos mostram que a IA ofereceu grade sem ter visto o marcador DISPONIVEL..."

Retorne sua proposta no formato JSON especificado.`
}

// ─── Match flexível de whitespace ────────────────────────────────────────────

/**
 * Tenta encontrar o `needle` no `haystack` com tolerância a diferenças de whitespace.
 * Retorna { match: <trecho real do haystack>, exact: bool } ou null se não encontrar.
 *
 * Estratégias em ordem:
 *  1. String.includes — match exato
 *  2. Regex com \s+ substituindo qualquer whitespace do needle
 */
function findFlexibleMatch(haystack, needle) {
  if (typeof haystack !== 'string' || typeof needle !== 'string' || !needle) return null
  if (haystack.includes(needle)) return { match: needle, exact: true }

  // Escapa regex chars do needle e substitui sequências de whitespace por \s+
  const escaped = needle
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
  let re
  try {
    re = new RegExp(escaped)
  } catch {
    return null
  }
  const m = haystack.match(re)
  if (!m) return null
  return { match: m[0], exact: false }
}

// ─── Função principal ─────────────────────────────────────────────────────────

/**
 * Analisa uma regra com base no ranking de violações e propõe uma mudança.
 *
 * @param {Record<string,string>} env
 * @param {{ regraAlvo: string, ranking: object, activeVersion: object }} opts
 * @returns {Promise<object>} Objeto da proposta validado
 */
export async function analyzeRule(env, { regraAlvo, ranking, activeVersion, instrucaoExtra = null }) {
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

  // 3b. Ordena por relevância e busca conversa completa para os 2 primeiros
  const ordenadosPorRelevancia = [...exemplos].sort((a, b) => {
    const sevOrder = { alta: 3, media: 2, baixa: 1 }
    const sevDiff = (sevOrder[b.severidade] || 0) - (sevOrder[a.severidade] || 0)
    if (sevDiff !== 0) return sevDiff
    return String(b.created_at || '').localeCompare(String(a.created_at || ''))
  })
  const exemplosComConversa = ordenadosPorRelevancia.slice(0, 2)
  const exemplosResumidos = ordenadosPorRelevancia.slice(2, 5)
  const feedbackIds = exemplosComConversa.map((e) => e.feedback_id).filter(Boolean)
  const conversasMap = feedbackIds.length > 0
    ? await fetchConversationsByFeedbackIds(env, feedbackIds)
    : new Map()

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
          exemplosComConversa,
          exemplosResumidos,
          conversasMap,
          totalViolacoes,
          instrucaoExtra: instrucaoExtra || null,
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
    if (!proposal.trecho_antes) {
      throw new Error('[analyzer/validation] trecho_antes vazio na proposta')
    }
    const found = findFlexibleMatch(agentRulesText, proposal.trecho_antes)
    if (!found) {
      console.error(
        `[analyzer/validation] trecho_antes não encontrado (nem com match flexível). Modelo retornou: "${String(proposal.trecho_antes).slice(0, 300)}"`,
      )
      throw new Error(
        '[analyzer/validation] trecho_antes não encontrado no prompt ativo, nem mesmo com tolerância de whitespace. O modelo parafraseou — clique em Analisar de novo, ou rejeite e tente outra regra.',
      )
    }
    if (!found.exact) {
      console.log(
        `[analyzer/validation] trecho_antes ajustado via match flexível (whitespace normalizado). Modelo original: "${proposal.trecho_antes.slice(0, 80)}..." → trecho real: "${found.match.slice(0, 80)}..."`,
      )
      proposal.trecho_antes = found.match
    }
  }

  return proposal
}

// ─── Prompts para análise multi-violação ─────────────────────────────────────

const SYSTEM_PROMPT_MULTI = `Você é um engenheiro de prompts especializado em corrigir regras de agentes conversacionais.

CONTEXTO:
Um agente de WhatsApp opera com regras numeradas (Regra 1 a Regra 18). O administrador selecionou manualmente N violações de diferentes regras para análise conjunta. Sua tarefa é propor mudanças cirúrgicas que cubram TODAS as violações selecionadas.

ENTRADA QUE VOCÊ RECEBE:
1. Texto completo do AGENT_RULES_TEXT atual.
2. Lista de violações selecionadas, agrupadas por regra, cada uma com execution_id, citação literal, severidade, descrição e conversa completa quando disponível.

Trechos entre marcadores <!-- IMUTÁVEL --> e <!-- /IMUTÁVEL --> NÃO podem ser modificados.

REGRAS DA SUA RESPOSTA:
0. Para cada regra violada no conjunto, decida SE ela precisa de mudança. Você pode gerar 1 proposta por regra afetada, ou 1 proposta que cubra múltiplas regras se fizer sentido consolidar.
1. Cirurgia, não cirurgia plástica: modifique o mínimo necessário.
2. Mantenha o tom: português brasileiro informal-profissional.
3. trecho_antes DEVE ser cópia LITERAL E EXATA de trecho contínuo do prompt atual (caractere a caractere).
4. Detecte conflitos entre regras e sinalize em conflitos_potenciais.
5. Se as violações sugerirem que o avaliador está classificando incorretamente, retorne tipo_mudanca="nenhuma" para essa regra e explique.

SAÍDA: JSON estrito, apenas o objeto, sem markdown:

{
  "propostas": [
    {
      "regra_alvo": "Regra X",
      "tipo_mudanca": "ajuste" | "consolidacao" | "novo_exemplo" | "remocao" | "nenhuma",
      "trecho_antes": "<texto literal copiado do prompt atual>",
      "trecho_depois": "<texto modificado, ou vazio se nenhuma>",
      "justificativa": "<2-4 frases>",
      "conflitos_potenciais": "<texto ou null>"
    }
  ]
}`

function buildMultiUserMessage({ agentRulesText, versao, violationsGroups, conversasMap, hint }) {
  const gruposTexto = violationsGroups.map((g) => {
    const examplesTexto = g.violations.map((v, i) => {
      const conversa = conversasMap.get(v.feedback_id)
      const conversaTexto = conversa ? formatConversa(conversa) : '(conversa não disponível)'
      return `#### Violação ${i + 1} (severidade: ${v.severidade}, execution_id: ${v.execution_id || 'n/a'})

Citação: "${v.citacao}"
Descrição: ${v.descricao}

Conversa:
${conversaTexto}`
    }).join('\n\n---\n\n')

    return `### ${g.regra} — ${g.violations.length} violação(ões) selecionada(s)

${examplesTexto}`
  }).join('\n\n═══\n\n')

  const hintBlock = hint ? `\n\nINSTRUÇÃO ADICIONAL DO ADMIN:\n${hint}` : ''

  return `PROMPT INTEIRO ATUAL (versão ${versao}):

---
${agentRulesText}
---

VIOLAÇÕES SELECIONADAS PELO ADMINISTRADOR (${violationsGroups.reduce((a, g) => a + g.violations.length, 0)} no total, ${violationsGroups.length} regra(s) distinta(s)):

${gruposTexto}${hintBlock}

Analise TODAS as violações acima. Gere propostas que cubram cada regra com problemas reais. Retorne o JSON especificado.`
}

// ─── Prompts para análise de acertos (falsos positivos) ──────────────────────

const SYSTEM_PROMPT_ACERTOS = `Você é um engenheiro de prompts especializado em corrigir regras de agentes conversacionais.

CONTEXTO:
Um agente de WhatsApp opera com regras numeradas (Regra 1 a Regra 18). O administrador marcou certas violações detectadas pelo avaliador automático como FALSOS POSITIVOS — ou seja, o avaliador errou, a IA agiu corretamente. Sua tarefa é propor mudanças no prompt que PROTEJAM ou REFORCEM esse comportamento correto da IA, evitando que o avaliador (e o agente) fique confuso no futuro.

ESTRATÉGIAS POSSÍVEIS:
- Adicionar uma exceção explícita na regra ("exceto quando X, pode Y")
- Adicionar um esclarecimento de critério ("isso NÃO é violação quando Z")
- Ajustar a linguagem da regra para ser mais precisa
- Se a regra está correta e o avaliador simplesmente errou sem padrão, retorne tipo_mudanca="nenhuma" explicando

Trechos entre <!-- IMUTÁVEL --> e <!-- /IMUTÁVEL --> NÃO podem ser modificados.

REGRAS DA SUA RESPOSTA:
1. Cirurgia, não cirurgia plástica: modifique o mínimo necessário.
2. Mantenha o tom: português brasileiro informal-profissional.
3. trecho_antes DEVE ser cópia LITERAL E EXATA do prompt atual.
4. Cada proposta deve ser ANCORADA no exemplo real recebido.
5. Detecte conflitos e sinalize em conflitos_potenciais.

SAÍDA: JSON estrito, apenas o objeto, sem markdown:

{
  "propostas": [
    {
      "regra_alvo": "Regra X",
      "tipo_mudanca": "ajuste" | "consolidacao" | "novo_exemplo" | "remocao" | "nenhuma",
      "trecho_antes": "<texto literal copiado do prompt atual>",
      "trecho_depois": "<texto modificado, ou vazio se nenhuma>",
      "justificativa": "<2-4 frases — inicie com 'Falso positivo: ...' explicando por que a IA agiu corretamente>",
      "conflitos_potenciais": "<texto ou null>"
    }
  ]
}`

function buildAcertosUserMessage({ agentRulesText, versao, acertos, conversasMap, hint }) {
  const acertosTexto = acertos.map((a, i) => {
    const conversa = conversasMap.get(a.feedback_id)
    const conversaTexto = conversa ? formatConversa(conversa) : '(conversa não disponível)'
    return `### Acerto ${i + 1} — ${a.regra}

O avaliador disse que houve violação de "${a.regra}", mas o administrador confirmou que a IA agiu CORRETAMENTE.

Citação do turno: "${a.citacao || '(sem citação)'}"
O que o avaliador disse: ${a.descricao_violacao || '(sem descrição)'}
Motivo do administrador para marcar como acerto: ${a.motivo || '(não informado)'}

Conversa completa:
${conversaTexto}`
  }).join('\n\n═══\n\n')

  const hintBlock = hint ? `\n\nINSTRUÇÃO ADICIONAL DO ADMIN:\n${hint}` : ''

  return `PROMPT INTEIRO ATUAL (versão ${versao}):

---
${agentRulesText}
---

FALSOS POSITIVOS CONFIRMADOS PELO ADMINISTRADOR (${acertos.length} no total):

${acertosTexto}${hintBlock}

Analise cada falso positivo. Proponha mudanças que protejam esses comportamentos corretos. Retorne o JSON especificado.`
}

// ─── Validação de propostas (reusada por multi e acertos) ─────────────────────

function validateAndNormalizeProposal(proposal, agentRulesText) {
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
    if (!proposal.trecho_antes) {
      throw new Error('[analyzer/validation] trecho_antes vazio na proposta')
    }
    const found = findFlexibleMatch(agentRulesText, proposal.trecho_antes)
    if (!found) {
      throw new Error(
        `[analyzer/validation] trecho_antes não encontrado no prompt ativo para "${proposal.regra_alvo}". O modelo parafraseou — tente reanalisar.`,
      )
    }
    if (!found.exact) {
      proposal.trecho_antes = found.match
    }
  }

  return proposal
}

// ─── runMultiViolationAnalyzer ────────────────────────────────────────────────

/**
 * Analisa N violações selecionadas manualmente e propõe mudanças cobrindo todas.
 *
 * violationIds: array de strings no formato "${feedback_id}:${regra}"
 *   Ex.: ["123:Regra 3", "456:Regra 7", "123:Regra 14"]
 *
 * Retorna: { propostas: proposalData[], janela_de, janela_ate, feedbackIds }
 */
export async function runMultiViolationAnalyzer(env, { violationIds, hint = null, activeVersion }) {
  if (!Array.isArray(violationIds) || violationIds.length === 0) {
    throw new Error('[multiAnalyzer/input] violationIds não pode ser vazio')
  }

  const agentRulesText = activeVersion.agent_rules_text

  // 1. Parseia os IDs no formato "feedbackId:regra"
  const parsed = violationIds.map((vid) => {
    const colonIdx = vid.indexOf(':')
    if (colonIdx < 1) throw new Error(`[multiAnalyzer/input] violationId inválido: "${vid}"`)
    return {
      feedbackId: vid.slice(0, colonIdx),
      regra: vid.slice(colonIdx + 1),
    }
  })

  // 2. Busca os ia_feedback rows
  const uniqueFeedbackIds = [...new Set(parsed.map((p) => p.feedbackId))]
  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[multiAnalyzer/config] SUPABASE_URL_FEEDBACK não configurado')

  let feedbackRows
  try {
    const idsCsv = uniqueFeedbackIds.map((id) => encodeURIComponent(id)).join(',')
    feedbackRows = await sb.select(
      'ia_feedback',
      `select=id,violacoes,conversa_completa,created_at&id=in.(${idsCsv})`,
    )
  } catch (err) {
    throw new Error(`[multiAnalyzer/supabase] Falha ao buscar ia_feedback: ${err.message}`)
  }

  const feedbackMap = new Map()
  for (const row of (Array.isArray(feedbackRows) ? feedbackRows : [])) {
    feedbackMap.set(String(row.id), row)
  }

  // 3. Extrai as violações correspondentes
  const violationsData = []
  for (const { feedbackId, regra } of parsed) {
    const row = feedbackMap.get(String(feedbackId))
    if (!row) {
      console.warn(`[multiAnalyzer] ia_feedback id=${feedbackId} não encontrado, pulando`)
      continue
    }
    const violacoes = Array.isArray(row.violacoes) ? row.violacoes : []
    const v = violacoes.find((vio) => String(vio.regra || '').trim() === regra.trim())
    if (!v) {
      console.warn(`[multiAnalyzer] regra "${regra}" não encontrada no feedback ${feedbackId}, pulando`)
      continue
    }
    violationsData.push({
      feedback_id: feedbackId,
      regra,
      severidade: v.severidade || 'baixa',
      citacao: v.citacao || '',
      descricao: v.descricao || '',
      execution_id: v.execution_id || null,
      created_at: row.created_at,
      conversa_completa: row.conversa_completa,
    })
  }

  if (violationsData.length === 0) {
    throw new Error('[multiAnalyzer/input] Nenhuma das violações indicadas foi encontrada nos registros de feedback')
  }

  // 4. Agrupa por regra para o prompt
  const byRegra = {}
  for (const v of violationsData) {
    if (!byRegra[v.regra]) byRegra[v.regra] = { regra: v.regra, violations: [] }
    byRegra[v.regra].violations.push(v)
  }
  const violationsGroups = Object.values(byRegra)

  // 5. Monta mapa de conversas (já temos in-memory)
  const conversasMap = new Map()
  for (const v of violationsData) {
    if (v.conversa_completa && !conversasMap.has(v.feedback_id)) {
      conversasMap.set(v.feedback_id, v.conversa_completa)
    }
  }

  // 6. Datas da janela
  const datas = violationsData.map((v) => v.created_at).filter(Boolean).sort()
  const janela_de = datas[0] || new Date().toISOString()
  const janela_ate = new Date().toISOString()

  // 7. Resolve modelo e chama OpenAI
  const model = resolveModel(env, 'prompt_optimizer')
  const key = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || ''
  if (!key) throw new Error('[multiAnalyzer/config] OPENAI_API_KEY não configurada')

  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_MULTI },
      {
        role: 'user',
        content: buildMultiUserMessage({
          agentRulesText,
          versao: activeVersion.versao,
          violationsGroups,
          conversasMap,
          hint,
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
      `[multiAnalyzer/openai] HTTP ${res.status} (modelo=${model}): ${errText.slice(0, 400) || res.statusText}`,
    )
  }

  const data = await res.json()
  const content = String(data?.choices?.[0]?.message?.content || '').trim()

  // 8. Parse JSON
  let parsed2
  try {
    parsed2 = JSON.parse(content)
  } catch (err) {
    throw new Error(`[multiAnalyzer/parser] Falha ao parsear resposta: ${err.message}`)
  }

  const propostas = Array.isArray(parsed2.propostas) ? parsed2.propostas : []
  if (propostas.length === 0) {
    throw new Error('[multiAnalyzer/parser] Modelo não retornou nenhuma proposta no campo "propostas"')
  }

  // 9. Valida cada proposta
  const propostasValidadas = []
  for (const p of propostas) {
    try {
      propostasValidadas.push(validateAndNormalizeProposal(p, agentRulesText))
    } catch (err) {
      console.error(`[multiAnalyzer/validation] Proposta rejeitada (${p.regra_alvo}): ${err.message}`)
    }
  }

  if (propostasValidadas.length === 0) {
    throw new Error('[multiAnalyzer/validation] Todas as propostas geradas falharam na validação')
  }

  return {
    propostas: propostasValidadas,
    janela_de,
    janela_ate,
    feedbackIds: uniqueFeedbackIds,
    violacoesEncontradas: violationsData.length,
  }
}

// ─── runAcertosAnalyzer ───────────────────────────────────────────────────────

/**
 * Analisa N falsos positivos confirmados e propõe mudanças para proteger o comportamento correto.
 *
 * acertoIds: array de UUIDs de ia_feedback_acertos
 *
 * Retorna: { propostas: proposalData[], janela_de, janela_ate, acertoIds }
 */
export async function runAcertosAnalyzer(env, { acertoIds, hint = null, activeVersion }) {
  if (!Array.isArray(acertoIds) || acertoIds.length === 0) {
    throw new Error('[acertosAnalyzer/input] acertoIds não pode ser vazio')
  }

  const agentRulesText = activeVersion.agent_rules_text

  const sb = getFeedbackSupabase(env)
  if (!sb) throw new Error('[acertosAnalyzer/config] SUPABASE_URL_FEEDBACK não configurado')

  // 1. Busca os acertos
  let acertosRows
  try {
    const idsCsv = acertoIds.map((id) => encodeURIComponent(id)).join(',')
    acertosRows = await sb.select(
      'ia_feedback_acertos',
      `select=id,feedback_id,regra,citacao,descricao_violacao,motivo,created_at&id=in.(${idsCsv})`,
    )
  } catch (err) {
    throw new Error(`[acertosAnalyzer/supabase] Falha ao buscar acertos: ${err.message}`)
  }

  const acertos = Array.isArray(acertosRows) ? acertosRows : []
  if (acertos.length === 0) {
    throw new Error('[acertosAnalyzer/input] Nenhum acerto encontrado com os IDs fornecidos')
  }

  // 2. Busca conversas
  const feedbackIds = [...new Set(acertos.map((a) => String(a.feedback_id)).filter(Boolean))]
  const conversasMap = feedbackIds.length > 0
    ? await fetchConversationsByFeedbackIds(env, feedbackIds)
    : new Map()

  // 3. Datas da janela
  const datas = acertos.map((a) => a.created_at).filter(Boolean).sort()
  const janela_de = datas[0] || new Date().toISOString()
  const janela_ate = new Date().toISOString()

  // 4. Resolve modelo e chama OpenAI
  const model = resolveModel(env, 'prompt_optimizer')
  const key = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || ''
  if (!key) throw new Error('[acertosAnalyzer/config] OPENAI_API_KEY não configurada')

  const body = {
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT_ACERTOS },
      {
        role: 'user',
        content: buildAcertosUserMessage({
          agentRulesText,
          versao: activeVersion.versao,
          acertos,
          conversasMap,
          hint,
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
      `[acertosAnalyzer/openai] HTTP ${res.status} (modelo=${model}): ${errText.slice(0, 400) || res.statusText}`,
    )
  }

  const data = await res.json()
  const content = String(data?.choices?.[0]?.message?.content || '').trim()

  // 5. Parse JSON
  let parsed2
  try {
    parsed2 = JSON.parse(content)
  } catch (err) {
    throw new Error(`[acertosAnalyzer/parser] Falha ao parsear resposta: ${err.message}`)
  }

  const propostas = Array.isArray(parsed2.propostas) ? parsed2.propostas : []
  if (propostas.length === 0) {
    throw new Error('[acertosAnalyzer/parser] Modelo não retornou nenhuma proposta')
  }

  // 6. Valida cada proposta
  const propostasValidadas = []
  for (const p of propostas) {
    try {
      propostasValidadas.push(validateAndNormalizeProposal(p, agentRulesText))
    } catch (err) {
      console.error(`[acertosAnalyzer/validation] Proposta rejeitada (${p.regra_alvo}): ${err.message}`)
    }
  }

  if (propostasValidadas.length === 0) {
    throw new Error('[acertosAnalyzer/validation] Todas as propostas geradas falharam na validação')
  }

  return {
    propostas: propostasValidadas,
    janela_de,
    janela_ate,
    acertoIds,
    acertosEncontrados: acertos.length,
  }
}
