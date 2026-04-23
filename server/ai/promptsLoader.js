/**
 * Carrega os prompts (systemMessage de cada node do n8n) a partir de public/APAGAR.txt.
 * Mesmo algoritmo do src/App.jsx (função extractPrompts), sem considerar os edits
 * que ficam no localStorage do browser.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APAGAR_PATH = join(__dirname, '..', '..', 'public', 'APAGAR.txt')

let cache = null
let cacheMtime = 0

function dig(params, out, depth = 0) {
  if (!params || typeof params !== 'object' || depth > 12) return
  if (Array.isArray(params)) {
    params.forEach((x) => dig(x, out, depth + 1))
    return
  }
  for (const [k, v] of Object.entries(params)) {
    if (k === 'systemMessage' && typeof v === 'string' && v.trim().length > 40) {
      let t = v.trim()
      if (t.startsWith('=') && !t.startsWith('={{')) t = t.slice(1).trim()
      out.push(t)
    } else if (v && typeof v === 'object') {
      dig(v, out, depth + 1)
    }
  }
}

function extractPrompts(data) {
  const nodes = data.nodes || []
  const prompts = []
  for (const node of nodes) {
    const texts = []
    dig(node.parameters || {}, texts)
    const uniq = [...new Set(texts)]
    if (uniq.length === 0) continue
    for (let i = 0; i < uniq.length; i++) {
      prompts.push({
        id: `${node.id || node.name || 'n'}-${i}`,
        name: node.name || 'Sem nome',
        type: (node.type || '').split('.').pop() || node.type || '',
        body: uniq[i],
      })
    }
  }
  return prompts
}

export async function loadPrompts() {
  try {
    const { mtimeMs } = await (await import('node:fs/promises')).stat(APAGAR_PATH)
    if (cache && cacheMtime === mtimeMs) return cache
    const raw = await readFile(APAGAR_PATH, 'utf8')
    const data = JSON.parse(raw)
    cache = extractPrompts(data)
    cacheMtime = mtimeMs
    return cache
  } catch (err) {
    console.error('[promptsLoader] erro ao ler APAGAR.txt:', err.message)
    return cache || []
  }
}

export function buildSystemMessage(prompts) {
  const promptsText = prompts.map((p) => `### ${p.name} (${p.type})\n\n${p.body}`).join('\n\n---\n\n')
  const override = `
## INSTRUÇÕES DO AGENTE (PRIORIDADE MÁXIMA)

Você está conectado ao WhatsApp via Evolution API. Regras abaixo substituem qualquer instrução conflitante dos prompts acima:

1. RESPONDA SEMPRE EM LINGUAGEM NATURAL, nunca em XML, JSON ou templates estruturados.
2. Você tem 8 tools reais: buscar_precos, buscar_informacoes, buscar_pos, buscar_perguntas, localizacao, inscricao, distribuir_humano e buscar_historico_conversa. USE-AS quando couber.
3. MEMÓRIA: o histórico recente da conversa já está injetado como mensagens anteriores do chat. Você só precisa chamar buscar_historico_conversa se faltarem detalhes antigos.
4. Para localização, execute localizacao com o texto completo que o usuário informou (cidade, rua e número ou CEP) e apresente polo, endereço, tempo estimado e o link da rota.
5. Para inscrição, use inscricao com curso e tipo_ingresso (ENEM ou Vestibular Múltipla Escolha).
6. Quando buscar preços ou informações, apresente os resultados de forma clara e objetiva.
7. Se a busca retornar cursos com nomes parecidos, apresente os encontrados e pergunte se é o que o usuário procura.
8. NÃO mencione ferramentas internas, tools, agentes ou contexto técnico ao usuário.
9. distribuir_humano exige id_lead e telefone; só use quando o RAG indicar ou não houver dados de curso para vender.
10. Seja direto, profissional e acolhedor.`
  return promptsText + '\n\n---\n\n' + override
}
