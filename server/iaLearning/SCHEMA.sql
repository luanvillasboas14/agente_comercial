-- Tabelas do sistema de Aprendizado Positivo (Supabase FEEDBACK).
-- Rodar uma vez no Supabase Feedback.

create table if not exists public.ia_aprendizado_batches (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  trigger text not null,                          -- 'manual' | 'cron'
  modelo_analisador text not null,
  leads_ids uuid[],
  total_leads int not null default 0,
  total_mensagens int not null default 0,
  status text not null default 'running',         -- running | success | failed
  raw_analyzer_response text,
  total_propostas_geradas int not null default 0,
  total_propostas_descartadas int not null default 0,
  total_exemplos_gerados int not null default 0,
  total_exemplos_descartados int not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists ia_aprendizado_batches_created_desc_idx
  on public.ia_aprendizado_batches (created_at desc);

create table if not exists public.ia_leads_convertidos (
  id uuid primary key default gen_random_uuid(),
  lead_id bigint unique not null,                 -- ID do lead Kommo
  detected_at timestamptz not null default now(),
  status_novo bigint not null,
  pipeline_id bigint,
  consultor_id bigint,
  consultor_nome text,
  fonte_conversa text,                            -- 'kommo_chats' | 'mensagens_atendimento_comercial' | 'hibrido'
  conversa_snapshot jsonb not null,
  total_mensagens int not null default 0,
  processed_at timestamptz,
  batch_id uuid references public.ia_aprendizado_batches(id) on delete set null,
  capture_error text,                             -- se snapshot falhou
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists ia_leads_convertidos_pending_idx
  on public.ia_leads_convertidos (detected_at desc)
  where processed_at is null and capture_error is null;
create index if not exists ia_leads_convertidos_detected_desc_idx
  on public.ia_leads_convertidos (detected_at desc);

create table if not exists public.ia_exemplos_conversas (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.ia_aprendizado_batches(id) on delete set null,
  categoria text not null,                        -- 'abertura' | 'preco' | 'objecao' | 'curso_especifico' | 'fechamento' | 'outro'
  contexto_resumido text,
  dialogo jsonb not null,                         -- [{remetente, texto}, ...]
  qualidade_score int not null,                   -- 1-5
  status text not null default 'pendente',        -- pendente | ativo | rejeitado | arquivado
  consultor_id bigint,
  consultor_nome text,
  fonte_lead_id bigint,
  ativado_em timestamptz,
  rejeitado_em timestamptz,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists ia_exemplos_conversas_ativo_idx
  on public.ia_exemplos_conversas (status, created_at desc)
  where status = 'ativo';
create index if not exists ia_exemplos_conversas_pendente_idx
  on public.ia_exemplos_conversas (status, created_at desc)
  where status = 'pendente';

-- Estender ia_prompt_proposals com origem
alter table public.ia_prompt_proposals
  add column if not exists origem text default 'feedback_negativo',
  add column if not exists batch_aprendizado_id uuid references public.ia_aprendizado_batches(id) on delete set null,
  add column if not exists support_count int;
-- origem possíveis: 'feedback_negativo' (fluxo atual) | 'aprendizado_positivo' (novo)
