-- Migração 2026-05-27 — Análise multi-violação
-- Adiciona colunas para rastrear propostas geradas a partir de múltiplas violações.
-- Também garante que a coluna `origem` exista (pode já ter sido adicionada por migração anterior do iaLearning).
--
-- Rode manualmente uma única vez no Supabase de Feedback.

ALTER TABLE ia_prompt_proposals
  ADD COLUMN IF NOT EXISTS origem text,
  ADD COLUMN IF NOT EXISTS violacoes_origem_ids jsonb;

-- Índice para filtrar propostas por origem (multi-violação, falso positivo, etc.)
CREATE INDEX IF NOT EXISTS idx_prompt_proposals_origem
  ON ia_prompt_proposals(origem)
  WHERE origem IS NOT NULL;
