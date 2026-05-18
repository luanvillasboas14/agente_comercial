-- Feedback IA — tabelas no Supabase de Feedback (SUPABASE_URL_FEEDBACK)
-- Rode manualmente uma única vez.

create table if not exists ia_feedback (
  id bigserial primary key,
  lead_id bigint,
  telefone text,
  pipeline_id_from int,
  status_id_from int,
  detected_at timestamptz not null,
  evaluated_at timestamptz default now(),
  conversa_completa jsonb,
  total_mensagens int default 0,
  total_turnos_ia int default 0,
  nota_geral numeric(3,1),
  veredito text, -- aprovado | parcial | reprovado
  resumo_avaliacao text,
  violacoes jsonb, -- [{regra, titulo, descricao, citacao, severidade}]
  pontos_positivos jsonb,
  modelo_avaliador text,
  job_execution_id uuid,
  created_at timestamptz default now()
);

create index if not exists ia_feedback_lead_id_idx on ia_feedback (lead_id);
create index if not exists ia_feedback_created_at_idx on ia_feedback (created_at desc);

create table if not exists ia_feedback_pendente (
  id bigserial primary key,
  lead_id bigint,
  telefone text,
  detected_at timestamptz not null,
  motivo_pendencia text, -- sem_conversa | conversa_curta | ia_falhou | erro_modelo
  conversa_pendente jsonb,
  job_execution_id uuid,
  created_at timestamptz default now()
);

create table if not exists ia_feedback_job_runs (
  id bigserial primary key,
  started_at timestamptz default now(),
  finished_at timestamptz,
  status text default 'running', -- running | success | error
  duration_ms bigint,
  trigger text, -- scheduler_diff | manual
  leads_detectados int default 0,
  avaliacoes_inseridas int default 0,
  pendentes_saved int default 0,
  ai_calls int default 0,
  errors_count int default 0,
  steps jsonb
);

create index if not exists ia_feedback_job_runs_started_at_idx on ia_feedback_job_runs (started_at desc);
