-- Migration: enriquecimento do Feedback Comercial (2026-07-01)
-- Rodar no Supabase de FEEDBACK (SUPABASE_URL_FEEDBACK), no SQL Editor.
--
-- Adiciona à tabela comercial_feedback:
--   * pontos_positivos / pontos_negativos (jsonb) — vários pontos por conversa,
--     cada um com { titulo, categoria, severidade?, citacao }. A "citacao" é o
--     trecho exato da conversa, usado pelo dashboard para grifar em vermelho os
--     pontos negativos.
--   * fase do funil (status_id + nome + categoria) e pipeline_id — permite
--     filtrar por fase no dashboard e dar tratamento diferente por funil.
--   * lead_perdido (bool) — quando a fase é "Perdido"; a nota já vem reduzida.
--
-- Idempotente: pode rodar mais de uma vez sem erro.

ALTER TABLE comercial_feedback
  ADD COLUMN IF NOT EXISTS pontos_positivos    jsonb,
  ADD COLUMN IF NOT EXISTS pontos_negativos    jsonb,
  ADD COLUMN IF NOT EXISTS fase_lead_status_id bigint,
  ADD COLUMN IF NOT EXISTS fase_lead_nome      text,
  ADD COLUMN IF NOT EXISTS fase_lead_categoria text,
  ADD COLUMN IF NOT EXISTS pipeline_id         bigint,
  ADD COLUMN IF NOT EXISTS lead_perdido        boolean;

-- Índices para os filtros do dashboard (por fase / perdido).
CREATE INDEX IF NOT EXISTS comercial_feedback_fase_status_idx
  ON comercial_feedback (fase_lead_status_id);

CREATE INDEX IF NOT EXISTS comercial_feedback_lead_perdido_idx
  ON comercial_feedback (lead_perdido);
