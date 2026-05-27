-- Migração: tabela de eventos de aceite sem filtro por consultor.
-- Rodar uma única vez no Supabase principal (SUPABASE_URL / SUPABASE_KEY).
-- Idempotente: CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS ia_aceites_eventos (
  id bigserial PRIMARY KEY,
  kommo_event_id text UNIQUE NOT NULL,
  entity_id bigint NOT NULL,
  created_by bigint,
  created_at_kommo timestamptz NOT NULL,
  status_id bigint NOT NULL,
  pipeline_id bigint NOT NULL,
  raw jsonb NOT NULL,
  inserted_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ia_aceites_eventos_entity_idx
  ON ia_aceites_eventos(entity_id);

CREATE INDEX IF NOT EXISTS ia_aceites_eventos_created_at_idx
  ON ia_aceites_eventos(created_at_kommo DESC);

CREATE INDEX IF NOT EXISTS ia_aceites_eventos_status_idx
  ON ia_aceites_eventos(status_id, pipeline_id);
