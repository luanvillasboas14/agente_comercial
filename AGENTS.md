# Agente Comercial — Notas de Contexto

Este documento concentra contexto operacional para agentes (humanos ou LLM) que vão trabalhar neste repositório.

## Estrutura do agente comercial

- **Webhook de entrada**: `server/evolution/webhookEvolution.js` — recebe mensagens do WhatsApp via Evolution API. Bufferiza e dispara fan-out para n8n (configurável).
- **Scheduler do agente**: `server/agentScheduler.js` — polling do Kommo a cada N segundos. Detecta leads em status monitorado, busca mensagens e aciona a IA. Também detecta saídas de funil para o sistema de Feedback IA.
- **Tools da IA**: `server/ai/toolExecutorsServer.js` — implementa as 8 tools do agente.
- **Prompt do agente**: `server/ai/promptsLoader.js` — `AGENT_RULES_TEXT` (Regras 1-18). **A partir do Otimizador de Prompt, esse texto vive na tabela `ia_prompt_versions` do Supabase de Feedback.** O hardcoded virou fallback.
- **Feedback IA**: avalia conversas após o lead sair do funil. Schema em `server/iaFeedback/SCHEMA.sql`. Runner em `server/iaFeedbackRunner.js`.
- **Otimizador de Prompt**: análise + correção do `AGENT_RULES_TEXT` via LLM com aprovação manual. Schema em `server/iaFeedback/PROMPT_OPTIMIZER_SCHEMA.sql`.

## Decisões técnicas

### 2026-05-19 — Otimizador de Prompt (versionamento + analisador LLM)

**Modelo usado pra decidir:** Opus 4.7 (principal).

**Decisão:** Sistema de melhoria contínua do `AGENT_RULES_TEXT` com 3 partes:

1. **Versionamento do prompt** — tabela `ia_prompt_versions` no Supabase de Feedback. Versão antiga sempre preservada. Cache em memória atualizado a cada 60s.
2. **Analisador LLM** — `o3-mini` (configurável via `OPENAI_MODEL_PROMPT_OPTIMIZER`). Recebe o prompt inteiro + a regra-alvo + até 5 exemplos de violações registradas pelo Feedback IA. Devolve proposta com `trecho_antes` (literal) + `trecho_depois` + justificativa + conflitos potenciais.
3. **Aprovação manual** — admin único (sem auth multi-user). Botão "Aceitar e aplicar" cria nova versão e ativa direto, sem segunda confirmação. Rollback 1-clique no histórico.

**Trigger:** Apenas manual (botão na UI). Sem cooldown, sem agendamento automático.

**Janela de análise:** Últimas 100 avaliações **DEPOIS** da ativação da versão atual. Erros que já motivaram uma correção anterior não contam de novo.

**Constituição imutável:** Trechos entre `<!-- IMUTÁVEL -->` e `<!-- /IMUTÁVEL -->` o analisador é instruído a não tocar. Hoje envolve só o cabeçalho `## INSTRUÇÕES DO AGENTE (PRIORIDADE MÁXIMA)` + parágrafo de abertura. Regras 1–18 mutáveis.

**Mitigações de risco aplicadas:**

- *Avaliador errado propaga pro prompt* → cada proposta exibe os exemplos de violação com `execution_id` e citação literal pra você conferir antes de aceitar.
- *Prompt incha indefinidamente* → o analisador é instruído (prompt do system) a preferir consolidação ou exceções curtas em vez de adicionar texto. Regras inchadas (>200 palavras) sinalizadas.
- *Conflito entre regras* → o modelo recebe o prompt inteiro e é obrigado a sinalizar conflitos no campo `conflitos_potenciais`.
- *Drift de tom/estilo* → instruído explicitamente sobre o tom (português brasileiro informal-profissional, sem jargão corporativo) e a manter as regras escritas no padrão atual.
- *Trecho_antes não casa* → validação literal `agentRulesText.includes(trecho_antes)` antes de salvar a proposta. No accept, segunda validação via `split/join` — se não muda nada, devolve 400.

**Alternativas descartadas:**

- *Aplicação automática sem revisão humana* → risco alto de cascatear erros do avaliador. Descartado.
- *Cooldown entre aplicações* → como admin é único e revisa cada uma, não faz sentido. Descartado.
- *Trigger automático (ex.: rodar quando atingir N violações)* → mais simples e seguro deixar manual. Pode evoluir depois se houver volume.
- *Tabela única de "histórico de mudanças"* → versionamento dedicado (`ia_prompt_versions`) permite rollback linear e auditoria explícita.

**Tabelas criadas:**
- `ia_prompt_versions(id, versao, agent_rules_text, ativa, activated_at, deactivated_at, created_by, origem_proposta_id, diff_resumo, metadata)`
- `ia_prompt_proposals(id, baseada_em_versao_id, modelo_analisador, status, regra_alvo, tipo_mudanca, trecho_antes, trecho_depois, justificativa, conflitos_potenciais, exemplos_violacoes, total_violacoes, janela_de, janela_ate, applied_at, rejected_at, resultado_versao_id, metadata)`

**Endpoints novos:**
- `GET /api/ia-feedback/violations-ranking`
- `POST /api/ia-feedback/analyze-rule` (body: `{ regra_alvo }`)
- `GET /api/ia-feedback/proposals?status=...`
- `GET /api/ia-feedback/proposals/:id`
- `POST /api/ia-feedback/proposals/:id/accept`
- `POST /api/ia-feedback/proposals/:id/reject`
- `GET /api/ia-feedback/prompt-versions`
- `GET /api/ia-feedback/prompt-versions/:id`
- `POST /api/ia-feedback/prompt-versions/:id/rollback`

### 2026-05-XX — Feedback IA (avaliação de conversas pós-funil)

**Modelo usado pra decidir:** Opus 4.7 (principal).

**Decisão:** Sistema dedicado que avalia se a IA seguiu as Regras 1-18 em conversas onde o lead saiu do funil monitorado. Trigger por snapshot-diff no scheduler (Redis), sem nova webhook do Kommo. Schema com 2 tabelas (`ia_feedback`, `ia_feedback_job_runs`) — casos `sem_conversa`/`conversa_curta` apenas logam e pulam, erros são salvos em `ia_feedback` com `veredito='erro'`. Modelo default `gpt-4.1` (configurável via `OPENAI_MODEL_IA_FEEDBACK`).

**Alternativas descartadas:**
- *Webhook adicional do Kommo* → não tem evento "funnel exit" nativo. Snapshot-diff é mais simples e cobre todos os casos.
- *Avaliar todas as conversas, não só pós-funil* → ruído alto. Saída do funil é o gate natural pra "conversa terminada".

### 2026-06-11 — Estratégia em 2 camadas pra eliminar erros críticos da IA

**Modelo usado pra decidir:** Opus 4.7 (principal).

**Decisão:** Para erros graves recorrentes (ex.: IA afirmando que pós-graduação tem matrícula isenta — falso), adotar 2 camadas complementares em vez de só evoluir o prompt:

1. **Hard guard determinístico** (`server/ai/replyGuards.js`): função pura que roda em [`webhookEvolution.js`](server/evolution/webhookEvolution.js) antes do envio pro WhatsApp. Intercepta resposta com padrão proibido via regex e reescreve com texto correto. Loga em `aiMeta.hardGuardsTriggered`. Rede de segurança imediata, independente de o LLM ter aprendido.
2. **Sistema "Confirmar negativo"** (`ia_feedback_negativos`): espelho exato do `ia_feedback_acertos`, mas com semântica oposta — operador marca uma violação como erro grave confirmado. Vira fila prioritária em "Otimizador de Prompt → Negativos confirmados pendentes" com analyzer dedicado (`runNegativosAnalyzer`) que gera propostas com framing firme. Sinal humano que evolui o prompt pela raiz.

Ambas convivem: guard cobre o pior caso agora, sistema de negativos faz o prompt amadurecer no longo prazo.

**Padrão pra criar novos guards:** adicionar nova função `guardX(reply)` em `replyGuards.js` seguindo o template do `guardPosIsencao`, com 5+ testes em `replyGuards.test.js`. Manter funções puras (sem I/O).

**Padrão pra novos tipos de feedback humano:** espelhar a tríade `acertosStore.js` + endpoint `/acertos/analyze` + seção "Acertos pendentes" no PromptOptimizer. Toda nova fila vira uma `origem` distinta em `ia_prompt_proposals` (ex.: `acerto`, `negativo_confirmado`, `aprendizado_positivo`, `feedback_negativo`).

**Alternativas descartadas:**
- *Só evoluir o prompt sem hard guard* → leva semanas pro modelo absorver, e enquanto isso clientes recebem info errada de pós.
- *Só hard guard sem sistema de negativos* → guard é frágil, não escala pra cada nova classe de erro; precisa do canal humano pra prompt evoluir.
- *+1/-1 em toda execução* (proposta original do usuário) → muito ruído, e infraestrutura de acertos+negativos no Feedback IA cobre o mesmo valor com escopo menor. +1 fica adiado.

### 2026-07-01 — Enriquecimento do Feedback Comercial (dados + prompt) com dashboard externo

**Modelo usado pra decidir:** Opus 4.8 (principal).

**Contexto:** O feedback comercial (avaliação dos consultores humanos, `server/feedbackJob.js` → tabela `comercial_feedback`) precisava de: timezone correto (SP), incluir mensagens pré-prontas do Kommo ("/"), fase do lead no funil, nota menor pra leads perdidos, vários pontos +/- por conversa, e trechos para grifar. A visualização é feita num **dashboard externo** (outro projeto); este repo é só backend/dados/prompt.

**Decisões:**

1. **Mensagens "/" = `sender_type='bot'` / `origin='bot'`.** Não têm prefixo "/" no texto salvo (vem o template expandido). Antes eram descartadas em `groupIntoSegments`. Agora: bot ANTES da 1ª mensagem do consultor (`sender_type='user'`) = automação/salesbot → descartado; bot DEPOIS = template disparado pelo consultor → reclassificado como `sender_type='user'`, marcado `is_template=true`, atribuído ao consultor. Marcador `[MSG PRONTA]` no `conversation_text`.

2. **Fase do funil por `status_id`/`pipeline_id`** (colunas que já existiam em `mensagens_atendimento_comercial` e não eram usadas). Fase do segmento = status/pipeline mais recente não nulo. Mapa `status_id → nome/categoria` em [`server/kommoStatusMap.js`](server/kommoStatusMap.js): estático (142=Ganho, 143=Perdido, 48566207=Aceite, 74941508=Aguardando resposta) + carga dinâmica via Kommo (`/api/v4/leads/pipelines`, cache 1h) em produção; cai no estático em dev sem token.

3. **Perdido = categoria 'perdido' (status 143).** Penalidade determinística na nota (`FEEDBACK_JOB_LOST_PENALTY` default 1.5, `FEEDBACK_JOB_LOST_MAX_NOTA` default 7) além da instrução no prompt — não depende só do LLM.

4. **Timezone:** `conversation_text` e novo `sent_at_sp` por mensagem em `America/Sao_Paulo` (o `sent_at` cru continua UTC ISO como fonte de verdade). Antes ia ISO cru ("...Z"), confundindo o dashboard.

5. **Schema de saída da IA expandido:** `pontos_positivos[]` e `pontos_negativos[]` (jsonb), cada ponto com `{ titulo, categoria, severidade?, citacao }`. A `citacao` é trecho literal da conversa → dashboard grifa em vermelho os negativos. Mantidos `ponto_positivo`/`ponto_negativo` (texto, join dos títulos) por compatibilidade. Critérios do Word incorporados (humanidade, info errada, contradição, confusão, NPS, insistência, satisfação por demora, qualidade das prontas, conhecimento, perguntas de gancho).

6. **Grounding pra detectar "informação errada"** ([`server/feedbackGrounding.js`](server/feedbackGrounding.js)): antes de avaliar, o job faz busca vetorial na MESMA base RAG do agente no Supabase PRINCIPAL (`match_documents` grad, `match_documents_pos` pós, `match_documents_perguntas` FAQ — 1 embedding, 3 RPCs) e injeta os trechos como "BASE DE CONHECIMENTO OFICIAL" no prompt. O avaliador só marca info errada quando há contradição clara com a base ou com as mensagens [MSG PRONTA] (templates aprovados). **PREÇO é excluído** (base de preços não é confiável — decisão do usuário): não consultamos `match_documents_precos` e ainda redigimos qualquer menção a valor/R$ no conteúdo. Toggle `FEEDBACK_JOB_GROUNDING_ENABLED` (default on), `FEEDBACK_JOB_GROUNDING_MAX_CHARS` (default 4000). Falha de grounding não derruba o segmento — só desliga a checagem de info errada naquela avaliação.

**Contrato pro dashboard externo (colunas novas em `comercial_feedback`, migration `server/MIGRATION_2026-07-01_feedback_comercial.sql`):** `pontos_positivos` jsonb, `pontos_negativos` jsonb, `fase_lead_status_id` bigint, `fase_lead_nome` text, `fase_lead_categoria` text (`ganho|perdido|em_andamento`), `pipeline_id` bigint, `lead_perdido` bool. Mensagens em `conversa_completa.messages[]` ganham `sent_at_sp`, `is_template`, `raw_sender_type`, `status_id`. **Aplicar a migration ANTES do deploy** — sem as colunas o INSERT/UPDATE do job falha.

**Alternativas descartadas:**
- *Detectar "/" pelo texto* → o texto salvo é o template expandido, nunca começa com "/". Só `sender_type='bot'` funciona.
- *Formatar timezone só no dashboard* → o `conversation_text` também vai pro LLM (que precisa raciocinar sobre horário útil SP); formatar na origem serve os dois.
- *Confiar só no LLM pra baixar nota de perdido* → adicionada trava determinística por robustez.

## Convenções

- Erros em código de servidor: prefixo `[modulo/categoria]` (ex.: `[analyzer/parser]`, `[promptVersionStore/supabase]`).
- IDs externos: `execution_id` (cada turno da IA), `lead_id` (Kommo), `versao` (incremental no `ia_prompt_versions`).
- Supabase principal: `SUPABASE_URL` / `SUPABASE_KEY` — armazena chat_messages, mensagens_ia, documentos da RAG.
- Supabase de Feedback: `SUPABASE_URL_FEEDBACK` / `SUPABASE_KEY_FEEDBACK` — armazena ia_feedback + ia_prompt_versions + ia_prompt_proposals.
- Comunicação com o usuário: português brasileiro informal-profissional. Sem emojis salvo se solicitado.
