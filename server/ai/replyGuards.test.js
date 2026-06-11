/**
 * Testes unitários para applyHardGuards.
 * Execute com: node server/ai/replyGuards.test.js
 */
import { applyHardGuards } from './replyGuards.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'

// --- Caso 1: resposta normal, sem trigger ---
test('resposta normal não dispara guard', () => {
  const reply = 'Nossos cursos de graduação têm ótimas condições de pagamento. Fale comigo para saber mais!'
  const result = applyHardGuards(reply)
  assert.equal(result.triggered, false)
  assert.equal(result.violations.length, 0)
  assert.equal(result.reply, reply)
})

// --- Caso 2: "A pós-graduação tem matrícula isenta." → trigger ---
test('pós-graduação com matrícula isenta dispara guard', () => {
  const reply = 'A pós-graduação tem matrícula isenta para novos alunos.'
  const result = applyHardGuards(reply)
  assert.equal(result.triggered, true)
  assert.equal(result.violations.length, 1)
  assert.equal(result.violations[0].guard, 'pos_isencao')
  assert.ok(result.reply.includes('R$ 99,00'), 'Resposta reescrita deve conter R$ 99,00')
  assert.ok(!result.reply.includes('isenta para novos alunos'), 'Trecho original não deve estar na resposta')
})

// --- Caso 3: "A graduação pode ter matrícula isenta." → NÃO dispara ---
test('graduação com matrícula isenta NÃO dispara guard', () => {
  const reply = 'A graduação pode ter matrícula isenta em algumas situações especiais.'
  const result = applyHardGuards(reply)
  assert.equal(result.triggered, false)
  assert.equal(result.reply, reply)
})

// --- Caso 4: "Pós é gratuita pra você!" → trigger ---
test('pós gratuita dispara guard', () => {
  const reply = 'Pós é gratuita pra você! Aproveite essa oportunidade.'
  const result = applyHardGuards(reply)
  assert.equal(result.triggered, true)
  assert.ok(result.reply.includes('R$ 99,00'))
})

// --- Caso 5: multi-parágrafo, só 1 viola → reescreve só ele ---
test('multi-parágrafo: reescreve só o parágrafo violador', () => {
  const paraOk = 'Temos diversas modalidades de ensino à distância com tutores dedicados.'
  const paraViolador = 'A pós-graduação tem isenção de matrícula para alunos novos.'
  const paraFinal = 'Entre em contato para saber mais sobre os cursos disponíveis.'
  const reply = [paraOk, paraViolador, paraFinal].join('\n\n')

  const result = applyHardGuards(reply)
  assert.equal(result.triggered, true)

  const parts = result.reply.split('\n\n')
  assert.equal(parts[0], paraOk, 'Primeiro parágrafo deve estar intacto')
  assert.ok(parts[1].includes('R$ 99,00'), 'Segundo parágrafo deve estar reescrito')
  assert.equal(parts[2], paraFinal, 'Terceiro parágrafo deve estar intacto')
})
