-- Migration: estender consultor_metricas_diarias para retornar lista de gaps > 15min.
-- Rodar no Supabase principal UMA VEZ.
-- Atenção: o ALTER de uma function que muda return type exige drop+create.

drop function if exists public.consultor_metricas_diarias(date);

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
  maior_intervalo_sem_acao_minutos int,
  gaps_maiores_15min jsonb
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
      lag(created_at_kommo) over (
        partition by created_by order by created_at_kommo
      ) as prev_at,
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
  gaps_list as (
    select
      created_by as consultor_id,
      jsonb_agg(
        jsonb_build_object(
          'inicio', prev_at,
          'fim', created_at_kommo,
          'duracao_minutos', round(gap_min)::int
        )
        order by prev_at
      ) as gaps_maiores_15min
    from com_gaps
    where gap_min is not null and gap_min > 15
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
    a.maior_intervalo_sem_acao_minutos,
    coalesce(g.gaps_maiores_15min, '[]'::jsonb) as gaps_maiores_15min
  from agg a
  left join por_tipo p using (consultor_id)
  left join gaps_list g using (consultor_id)
  order by a.total_acoes desc;
$$;
