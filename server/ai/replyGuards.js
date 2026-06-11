/**
 * Hard guards determinísticos aplicados sobre a resposta da IA antes do envio.
 *
 * Regras:
 *   - Funções puras: sem I/O, sem fetch, sem variáveis de ambiente.
 *   - Cada guard detecta um padrão e reescreve o trecho problemático.
 *   - O restante da resposta (parágrafos não-violadores) é preservado.
 */

// Regex pra detectar menção a pós-graduação
const RE_POS = /\b(p[óo]s[\s\-]?gradua[çc][ãa]o|p[óo]s)\b/i

// Regex pra detectar menção a isenção / gratuidade de matrícula
const RE_ISENCAO =
  /\b(isenta|isen[çc][ãa]o|gratuita|sem custo|sem taxa|n[ãa]o tem custo|n[ãa]o paga matr[íi]cula)\b/i

const REPLACEMENT_POS_ISENCAO =
  'A pós-graduação tem matrícula única no valor de R$ 99,00 (válida para todos os cursos). ' +
  'Apenas a graduação pode ter matrícula isenta em algumas situações específicas.'

/**
 * Verifica se um segmento de texto contém AMBOS os padrões com distância < 200 chars.
 * @param {string} segment
 * @returns {boolean}
 */
function segmentViolatesPosIsencao(segment) {
  const posMatch = RE_POS.exec(segment)
  const isencaoMatch = RE_ISENCAO.exec(segment)
  if (!posMatch || !isencaoMatch) return false
  return Math.abs(posMatch.index - isencaoMatch.index) < 200
}

/**
 * Guard 1: pós-graduação com isenção/gratuidade.
 *
 * Divide a resposta em parágrafos (\n\n) e depois em frases (. ! ?).
 * Se um segmento dispara o guard, substitui apenas aquele segmento.
 * Parágrafos sem violação são mantidos intactos.
 *
 * @param {string} reply
 * @returns {{ reply: string, triggered: boolean, violation: object|null }}
 */
function guardPosIsencao(reply) {
  const paragraphs = reply.split(/\n\n/)
  let triggered = false
  let original = null

  const rewritten = paragraphs.map((para) => {
    // Verifica o parágrafo inteiro primeiro (cobre casos onde pos e isenção
    // estão em frases adjacentes dentro do mesmo bloco)
    if (segmentViolatesPosIsencao(para)) {
      if (!triggered) {
        triggered = true
        original = para
      }
      return REPLACEMENT_POS_ISENCAO
    }

    // Se o parágrafo não viola como bloco, verifica frase a frase
    const sentences = para.split(/(?<=[.!?])\s+/)
    let paraTriggered = false
    const rewrittenSentences = sentences.map((sentence) => {
      if (segmentViolatesPosIsencao(sentence)) {
        if (!triggered) {
          triggered = true
          original = sentence
        }
        paraTriggered = true
        return REPLACEMENT_POS_ISENCAO
      }
      return sentence
    })

    return paraTriggered ? rewrittenSentences.join(' ') : para
  })

  const violation = triggered
    ? {
        guard: 'pos_isencao',
        original,
        replacement: REPLACEMENT_POS_ISENCAO,
        reason:
          'Resposta mencionava pós-graduação como isenta/gratuita. ' +
          'Apenas a graduação pode ter matrícula isenta.',
      }
    : null

  return {
    reply: rewritten.join('\n\n'),
    triggered,
    violation,
  }
}

/**
 * Aplica todos os hard guards sobre a resposta da IA antes do envio.
 *
 * @param {string} originalReply
 * @returns {{ reply: string, triggered: boolean, violations: Array<{guard: string, original: string, replacement: string, reason: string}> }}
 */
export function applyHardGuards(originalReply) {
  const violations = []
  let current = originalReply

  const g1 = guardPosIsencao(current)
  if (g1.triggered) {
    current = g1.reply
    violations.push(g1.violation)
  }

  return {
    reply: current,
    triggered: violations.length > 0,
    violations,
  }
}
