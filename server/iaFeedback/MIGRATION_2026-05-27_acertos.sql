-- Migração 2026-05-27 — Tabela de acertos (falsos positivos)
-- Registra violações detectadas pelo avaliador que na verdade foram comportamentos corretos.
--
-- Rode manualmente uma única vez no Supabase de Feedback.

CREATE TABLE IF NOT EXISTS ia_feedback_acertos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  feedback_id bigint REFERENCES ia_feedback(id),
  regra text NOT NULL,
  citacao text,
  descricao_violacao text,
  motivo text,
  created_at timestamptz DEFAULT now(),
  created_by text DEFAULT 'user',
  processed_at timestamptz,
  proposta_id uuid REFERENCES ia_prompt_proposals(id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_acertos_feedback_id
  ON ia_feedback_acertos(feedback_id);

CREATE INDEX IF NOT EXISTS idx_feedback_acertos_processed
  ON ia_feedback_acertos(processed_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_acertos_regra
  ON ia_feedback_acertos(regra);
