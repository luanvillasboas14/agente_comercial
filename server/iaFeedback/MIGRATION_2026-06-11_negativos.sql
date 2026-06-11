-- Migration: ia_feedback_negativos
-- Criada em: 2026-06-11
-- NÃO APLICAR AUTOMATICAMENTE — executar manualmente no Supabase de Feedback

CREATE TABLE IF NOT EXISTS ia_feedback_negativos (
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

CREATE INDEX IF NOT EXISTS idx_feedback_negativos_feedback_id
  ON ia_feedback_negativos(feedback_id);

CREATE INDEX IF NOT EXISTS idx_feedback_negativos_processed
  ON ia_feedback_negativos(processed_at)
  WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_negativos_regra
  ON ia_feedback_negativos(regra);
