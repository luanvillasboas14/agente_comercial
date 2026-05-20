-- Tabelas pra auditoria diária de eventos Kommo (rodar no Supabase PRINCIPAL).
create table if not exists public.kommo_event_sync_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  reference_date date not null,
  status text not null default 'running', -- running | success | failed | failed_critical
  total_groups int not null default 0,
  total_pages int not null default 0,
  total_events_received int not null default 0,
  total_events_inserted int not null default 0,
  error_message text,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists kommo_event_sync_runs_started_desc_idx
  on public.kommo_event_sync_runs (started_at desc);
create index if not exists kommo_event_sync_runs_ref_date_idx
  on public.kommo_event_sync_runs (reference_date);

create table if not exists public.kommo_consultor_eventos (
  id bigserial primary key,
  kommo_event_id text unique not null,
  created_at_kommo timestamptz not null,
  created_by bigint,
  entity_type text,
  entity_id bigint,
  event_type text,
  event_data jsonb,
  raw jsonb not null,
  sync_run_id bigint references public.kommo_event_sync_runs(id) on delete set null,
  inserted_at timestamptz not null default now()
);
create index if not exists kommo_consultor_eventos_created_by_at_idx
  on public.kommo_consultor_eventos (created_by, created_at_kommo desc);
create index if not exists kommo_consultor_eventos_created_at_idx
  on public.kommo_consultor_eventos (created_at_kommo desc);
create index if not exists kommo_consultor_eventos_entity_idx
  on public.kommo_consultor_eventos (entity_type, entity_id);

-- Função de métricas. Calcula tempo ativo somando gaps <= 15min entre eventos.
create or replace function public.consultor_metricas_diarias(p_data date)
returns table (
  data date,
  consultor_id bigint,
  primeira_acao timestamptz,
  ultima_acao timestamptz,
  total_acoes int,
  total_leads_unicos int,
  total_eventos_por_tipo jsonb,
  tempo_ativo_estimado_minutos int,
  maior_intervalo_sem_acao_minutos int
)
language sql stable
as $$
  with eventos_dia as (
    select
      e.created_by,
      e.created_at_kommo,
      e.event_type,
      e.entity_id,
      e.entity_type
    from public.kommo_consultor_eventos e
    where e.created_by is not null
      and (e.created_at_kommo at time zone 'America/Sao_Paulo')::date = p_data
  ),
  com_gaps as (
    select
      created_by,
      created_at_kommo,
      event_type,
      entity_id,
      entity_type,
      extract(epoch from (
        created_at_kommo - lag(created_at_kommo) over (
          partition by created_by order by created_at_kommo
        )
      )) / 60.0 as gap_min
    from eventos_dia
  ),
  agg as (
    select
      created_by as consultor_id,
      min(created_at_kommo) as primeira_acao,
      max(created_at_kommo) as ultima_acao,
      count(*)::int as total_acoes,
      count(distinct case when entity_type = 'lead' then entity_id end)::int as total_leads_unicos,
      coalesce(
        sum(case when gap_min is not null and gap_min <= 15 then gap_min else 0 end),
        0
      )::int as tempo_ativo_estimado_minutos,
      coalesce(max(case when gap_min is not null and gap_min > 15 then gap_min end), 0)::int
        as maior_intervalo_sem_acao_minutos
    from com_gaps
    group by created_by
  ),
  por_tipo as (
    select
      created_by as consultor_id,
      jsonb_object_agg(event_type, qtd) as total_eventos_por_tipo
    from (
      select created_by, coalesce(event_type, 'desconhecido') as event_type, count(*) as qtd
      from eventos_dia
      group by created_by, event_type
    ) t
    group by created_by
  )
  select
    p_data as data,
    a.consultor_id,
    a.primeira_acao,
    a.ultima_acao,
    a.total_acoes,
    a.total_leads_unicos,
    coalesce(p.total_eventos_por_tipo, '{}'::jsonb) as total_eventos_por_tipo,
    a.tempo_ativo_estimado_minutos,
    a.maior_intervalo_sem_acao_minutos
  from agg a
  left join por_tipo p using (consultor_id)
  order by a.total_acoes desc;
$$;
