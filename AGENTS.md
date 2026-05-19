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

## Convenções

- Erros em código de servidor: prefixo `[modulo/categoria]` (ex.: `[analyzer/parser]`, `[promptVersionStore/supabase]`).
- IDs externos: `execution_id` (cada turno da IA), `lead_id` (Kommo), `versao` (incremental no `ia_prompt_versions`).
- Supabase principal: `SUPABASE_URL` / `SUPABASE_KEY` — armazena chat_messages, mensagens_ia, documentos da RAG.
- Supabase de Feedback: `SUPABASE_URL_FEEDBACK` / `SUPABASE_KEY_FEEDBACK` — armazena ia_feedback + ia_prompt_versions + ia_prompt_proposals.
- Comunicação com o usuário: português brasileiro informal-profissional. Sem emojis salvo se solicitado.
