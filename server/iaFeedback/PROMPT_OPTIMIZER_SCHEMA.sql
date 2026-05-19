-- Otimizador de Prompt — tabelas no Supabase de Feedback
-- Rode manualmente uma única vez.

create table if not exists ia_prompt_versions (
  id uuid primary key default gen_random_uuid(),
  versao integer not null,
  agent_rules_text text not null,
  ativa boolean not null default false,
  activated_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  created_by text, -- 'seed' | 'manual_rollback' | 'analyzer:<proposal_id>'
  origem_proposta_id uuid,
  diff_resumo text,
  metadata jsonb default '{}'::jsonb
);

create unique index if not exists uniq_prompt_versions_versao on ia_prompt_versions(versao);
create unique index if not exists uniq_prompt_versions_ativa on ia_prompt_versions(ativa) where ativa = true;
create index if not exists idx_prompt_versions_activated_at on ia_prompt_versions(activated_at desc);

create table if not exists ia_prompt_proposals (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  baseada_em_versao_id uuid not null references ia_prompt_versions(id),
  modelo_analisador text not null,
  status text not null default 'pendente', -- 'pendente' | 'aplicada' | 'rejeitada'
  applied_at timestamptz,
  rejected_at timestamptz,
  resultado_versao_id uuid references ia_prompt_versions(id),

  regra_alvo text not null,
  tipo_mudanca text not null, -- 'ajuste' | 'consolidacao' | 'novo_exemplo' | 'remocao' | 'nenhuma'
  trecho_antes text not null,
  trecho_depois text not null,
  justificativa text not null,
  conflitos_potenciais text,
  exemplos_violacoes jsonb,

  total_violacoes integer not null,
  janela_de timestamptz not null,
  janela_ate timestamptz not null,
  metadata jsonb default '{}'::jsonb
);

create index if not exists idx_prompt_proposals_status on ia_prompt_proposals(status, created_at desc);
create index if not exists idx_prompt_proposals_regra on ia_prompt_proposals(regra_alvo, status);
