/**
 * Analisador de batch de conversas de leads convertidos.
 * Envia conversas ao o3-mini para extrair regras e exemplos de bom atendimento.
 */

import { listPendentes, marcarProcessados } from './leadsConvertidosStore.js'
import { createBatch, finishBatch } from './batchesStore.js'
import { createExample } from './examplesStore.js'
import { getFeedbackSupabase } from '../iaFeedback/supabaseClient.js'
import { resolveModel } from '../ai/modelRegistry.js'
import { getActiveVersion } from '../iaFeedback/promptVersionStore.js'

/**
 * Trunca a conversa a um máximo de caracteres por conversa.
 */
function truncateConversa(mensagens, maxChars = 2000) {
  let out = []
  let total = 0
  for (const m of (Array.isArray(mensagens) ? mensagens : [])) {
    const line = `  ${m.ts ? m.ts.slice(0, 16).replace('T', ' ') : '?'} ${m.remetente === 'lead' ? 'LEAD' : 'CONSULTOR'}: ${String(m.texto || '').slice(0, 300)}`
    if (total + line.length > maxChars) {
      out.push('  [... conversa truncada ...]')
      break
    }
    out.push(line)
    total += line.length
  }
  return out.join('\n')
}

/**
 * Monta o prompt do sistema para o analyzer.
 */
function buildAnalyzerPrompt(leadsData, { minSupport, minQuality, minExamples, maxExamples }) {
  const batchText = leadsData.map((ld, i) => {
    const snap = ld.conversa_snapshot || {}
    const msgs = Array.isArray(snap.mensagens) ? snap.mensagens : []
    const transcricao = truncateConversa(msgs, 2000)
    return `[${i + 1}] lead_id=${ld.lead_id} consultor=${ld.consultor_nome || 'desconhecido'} total_msgs=${ld.total_mensagens}\n${transcricao || '  (sem mensagens)'}`
  }).join('\n\n')

  return {
    system: `Você é um analista que estuda conversas REAIS entre consultores humanos e leads que CONVERTERAM (compraram o curso).
Seu objetivo é extrair APRENDIZADO POSITIVO pra melhorar uma IA de atendimento.

Você recebe um BATCH de ${leadsData.length} conversas. Analise TODAS antes de propor.

META DE QUANTIDADE (importante):
- Você DEVE extrair entre ${minExamples} e ${maxExamples} exemplos no total.
- Escale com o tamanho do batch: batches maiores → mais exemplos (mais material disponível).
- Sugestão: ~1 exemplo por cada ${Math.max(5, Math.floor(leadsData.length / Math.max(1, maxExamples)))} conversas, sem ultrapassar ${maxExamples}.
- Diversifique por categoria (abertura, preço, objeção, curso_específico, fechamento) — não concentre tudo em uma só.
- Cada exemplo precisa vir de uma conversa DIFERENTE (não pegue 2 exemplos do mesmo lead_id).
- Se um padrão excelente aparecer várias vezes, prefira propor REGRA (regras_propostas) em vez de duplicar exemplos.

Você deve retornar exatamente este JSON:
{
  "regras_propostas": [
    {
      "regra_alvo": "string — qual regra/seção do prompt esta proposta afeta (ex: 'REGRA 14 — PREÇOS' ou 'NOVA REGRA — TOM')",
      "trecho_antes": "string — trecho LITERAL do prompt atual a substituir, OU vazio se for adição",
      "trecho_depois": "string — texto novo proposto",
      "justificativa": "string — POR QUE essa mudança baseada nas conversas",
      "support_count": "número — em quantas conversas do batch esse padrão apareceu (CRÍTICO: descarto < ${minSupport})"
    }
  ],
  "exemplos_extraidos": [
    {
      "categoria": "abertura|preco|objecao|curso_especifico|fechamento|outro",
      "contexto_resumido": "string curta — situação do diálogo",
      "dialogo": [
        { "remetente": "lead", "texto": "string" }
      ],
      "qualidade_score": "número 1-5 — quão exemplar é",
      "fonte_lead_id": "número — qual lead do batch originou",
      "consultor_nome": "string"
    }
  ]
}

REGRAS DURAS:
- NÃO invente padrões. Só proponha se apareceu em >= ${minSupport} conversas.
- NÃO altere regras críticas (transferência humana, dados sensíveis, preços específicos).
- Cada exemplo deve ser AUTOCONTIDO (2-6 turnos), formatação preservada (incluindo emojis).
- Foque em tom, ritmo, calor humano, formato de respostas — não em regras técnicas que a IA já tem.
- Se uma conversa contiver dados pessoais óbvios (nome completo, CPF, telefone), anonimize: "[nome]", "[cpf]", "[telefone]".
- Prefira consolidar ou adicionar exceções curtas em vez de adicionar muito texto.
- Mantenha o tom: português brasileiro informal-profissional, sem jargão corporativo.`,
    user: `Conversas do batch:\n\n${batchText}`,
  }
}

/**
 * Tenta parsear a resposta do model como JSON.
 * Aceita tanto JSON puro quanto JSON embutido em markdown code fence.
 */
function parseAnalyzerResponse(raw) {
  if (!raw) return null
  let text = raw.trim()
  // Remove markdown code fences se presentes
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) text = fenceMatch[1].trim()
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Função principal do batch analyzer.
 */
export async function runBatchAnalysis(env, { trigger = 'manual', limit = null } = {}) {
  const minBatch = Math.max(1, Number(env.IA_LEARNING_MIN_BATCH_SIZE || 50))
  // Teto de segurança pra não estourar contexto do modelo. Pode ser ajustado
  // via env. Default 200 (≈ o3-mini com folga). Em batches maiores risco de
  // truncamento aumenta.
  const maxBatch = Math.max(minBatch, Number(env.IA_LEARNING_MAX_BATCH_SIZE || 200))
  const minSupport = Math.max(1, Number(env.IA_LEARNING_MIN_SUPPORT || 5))
  const minQuality = Math.max(1, Number(env.IA_LEARNING_MIN_EXAMPLE_QUALITY || 3))
  // Quantidade de exemplos esperada — escala com tamanho do batch.
  // Defaults: piso 2, teto = max(5, batchSize/10). Pode override via env.
  const minExamplesEnv = Number(env.IA_LEARNING_MIN_EXAMPLES_PER_BATCH || 0)
  const maxExamplesEnv = Number(env.IA_LEARNING_MAX_EXAMPLES_PER_BATCH || 0)

  // 1) Busca pendentes — pede até `maxBatch` (ou o limite manual passado).
  // listPendentes tem hard cap interno de 500, suficiente pra um batch.
  const fetchLimit = limit != null ? Number(limit) : maxBatch
  const pendentes = await listPendentes(env, fetchLimit)

  if (pendentes.length < minBatch) {
    console.log(`[IaLearning] analyzer: min_not_reached pendentes=${pendentes.length} min=${minBatch}`)
    return { ok: false, reason: 'min_not_reached', pendentes: pendentes.length, min: minBatch }
  }

  // 2) Usa TODAS as conversas disponíveis (até o teto maxBatch).
  // Order asc do store garante FIFO — conversas mais antigas vão primeiro.
  const tamanhoBatch = Math.min(pendentes.length, maxBatch)
  const leadsParaBatch = pendentes.slice(0, tamanhoBatch)
  console.log(`[IaLearning] analyzer: batch usará ${leadsParaBatch.length} conversas (pendentes=${pendentes.length} min=${minBatch} max=${maxBatch})`)
  const totalMensagens = leadsParaBatch.reduce((acc, l) => acc + (l.total_mensagens || 0), 0)
  const leadsIds = leadsParaBatch.map((l) => l.id)

  // 3) Cria batch
  const modelo = resolveModel(env, 'learning_analyzer')
  const batchId = await createBatch(env, {
    trigger,
    modelo,
    leadsIds,
    totalLeads: leadsParaBatch.length,
    totalMensagens,
  })

  console.log(`[IaLearning] analyzer: batch=${batchId} leads=${leadsParaBatch.length} msgs=${totalMensagens} model=${modelo}`)

  let rawJson = null

  try {
    // 4) Monta prompt
    // Resolve metas de quantidade de exemplos baseado no tamanho real do batch
    const minExamples = minExamplesEnv > 0 ? minExamplesEnv : 2
    const maxExamples = maxExamplesEnv > 0 ? maxExamplesEnv : Math.max(5, Math.ceil(leadsParaBatch.length / 10))
    const { system, user } = buildAnalyzerPrompt(leadsParaBatch, { minSupport, minQuality, minExamples, maxExamples })
    console.log(`[IaLearning] analyzer: meta exemplos = entre ${minExamples} e ${maxExamples} (batch=${leadsParaBatch.length})`)

    // 5) Chama OpenAI via fetch direto (padrão do projeto, sem SDK)
    const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY || ''
    if (!apiKey) throw new Error('[IaLearning/analyzer] OPENAI_API_KEY não configurada')

    const timeoutMs = Number(env.IA_LEARNING_OPENAI_TIMEOUT_MS || 300_000)

    async function callOpenAI(body) {
      const controller = new AbortController()
      const to = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          const err = new Error(`HTTP ${res.status}: ${errText.slice(0, 400) || res.statusText}`)
          err.status = res.status
          err.body = errText
          throw err
        }
        const data = await res.json()
        return String(data?.choices?.[0]?.message?.content || '').trim()
      } finally {
        clearTimeout(to)
      }
    }

    const baseMessages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]

    let responseText
    try {
      responseText = await callOpenAI({
        model: modelo,
        response_format: { type: 'json_object' },
        messages: baseMessages,
      })
    } catch (openaiErr) {
      // Se modelo não suporta json_object, tenta sem
      const msg = String(openaiErr.message || '')
      const body = String(openaiErr.body || '')
      const notSupported = /response_format|json_object/i.test(msg) || /response_format|json_object/i.test(body)
      if (notSupported) {
        console.warn(`[IaLearning] analyzer: json_object não suportado pelo modelo ${modelo}, tentando sem`)
        responseText = await callOpenAI({ model: modelo, messages: baseMessages })
      } else {
        throw openaiErr
      }
    }

    rawJson = responseText

    // 6) Parseia resposta
    const parsed = parseAnalyzerResponse(responseText)
    if (!parsed) {
      throw new Error(`[IaLearning/analyzer] resposta do modelo não é JSON válido: ${responseText.slice(0, 200)}`)
    }

    const regrasBrutas = Array.isArray(parsed.regras_propostas) ? parsed.regras_propostas : []
    const exemplosBrutos = Array.isArray(parsed.exemplos_extraidos) ? parsed.exemplos_extraidos : []

    // 7) Filtra por support_count e quality_score
    const regrasAceitas = regrasBrutas.filter((r) => Number(r.support_count) >= minSupport)
    const regrasDescartadas = regrasBrutas.length - regrasAceitas.length
    const exemplosAceitos = exemplosBrutos.filter((e) => Number(e.qualidade_score) >= minQuality)
    const exemplosDescartados = exemplosBrutos.length - exemplosAceitos.length

    console.log(
      `[IaLearning] analyzer: regras aceitas=${regrasAceitas.length} descartadas=${regrasDescartadas} ` +
      `exemplos aceitos=${exemplosAceitos.length} descartados=${exemplosDescartados}`,
    )

    // 8) Persiste regras como ia_prompt_proposals
    const sb = getFeedbackSupabase(env)
    if (!sb) throw new Error('[IaLearning/analyzer] SUPABASE_URL_FEEDBACK não configurado')

    let activeVersionId = null
    try {
      const av = await getActiveVersion(env)
      activeVersionId = av?.id || null
    } catch (_) {}

    for (const r of regrasAceitas) {
      try {
        await sb.insert('ia_prompt_proposals', {
          regra_alvo: String(r.regra_alvo || '').slice(0, 500),
          trecho_antes: String(r.trecho_antes || ''),
          trecho_depois: String(r.trecho_depois || ''),
          justificativa: String(r.justificativa || ''),
          conflitos_potenciais: null,
          exemplos_violacoes: [],
          total_violacoes: 0,
          status: 'pendente',
          modelo_analisador: modelo,
          tipo_mudanca: r.trecho_antes ? 'ajuste' : 'novo_exemplo',
          origem: 'aprendizado_positivo',
          batch_aprendizado_id: batchId,
          support_count: Number(r.support_count) || 0,
          baseada_em_versao_id: activeVersionId,
        })
      } catch (e) {
        console.warn(`[IaLearning/analyzer] inserir regra falhou: ${e.message}`)
      }
    }

    // 9) Persiste exemplos como ia_exemplos_conversas
    for (const e of exemplosAceitos) {
      try {
        await createExample(env, {
          batch_id: batchId,
          categoria: String(e.categoria || 'outro'),
          contexto_resumido: String(e.contexto_resumido || '').slice(0, 500),
          dialogo: Array.isArray(e.dialogo) ? e.dialogo : [],
          qualidade_score: Number(e.qualidade_score) || 3,
          consultor_nome: String(e.consultor_nome || '') || null,
          fonte_lead_id: Number(e.fonte_lead_id) || null,
        })
      } catch (err) {
        console.warn(`[IaLearning/analyzer] inserir exemplo falhou: ${err.message}`)
      }
    }

    // 10) Marca leads como processados
    await marcarProcessados(env, leadsIds, batchId)

    // 11) Finaliza batch
    await finishBatch(env, batchId, {
      status: 'success',
      total_propostas_geradas: regrasAceitas.length,
      total_propostas_descartadas: regrasDescartadas,
      total_exemplos_gerados: exemplosAceitos.length,
      total_exemplos_descartados: exemplosDescartados,
      raw_analyzer_response: rawJson,
    })

    return {
      ok: true,
      batchId,
      totalLeads: leadsParaBatch.length,
      totalMensagens,
      modelo,
      regrasGeradas: regrasAceitas.length,
      regrasDescartadas,
      exemplosGerados: exemplosAceitos.length,
      exemplosDescartados,
    }
  } catch (err) {
    console.error(`[IaLearning] analyzer FAIL: ${err.message}`)
    await finishBatch(env, batchId, {
      status: 'failed',
      raw_analyzer_response: rawJson,
      error_message: err.message.slice(0, 1000),
    }).catch(() => {})
    throw err
  }
}
