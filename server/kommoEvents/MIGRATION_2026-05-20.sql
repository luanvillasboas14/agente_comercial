-- Migration: kommo_event_id deve ser text (Kommo retorna IDs como string,
-- não bigint — formato tipo "9cad1b8a-05fb-45ff-8afe-82885b29ed74").
-- Rodar no Supabase principal UMA VEZ.

alter table public.kommo_consultor_eventos
  alter column kommo_event_id type text using kommo_event_id::text;

-- Como a primeira execução já entrou com 0 inserts (todas falharam), não há
-- dado a preservar. Mas se houver linhas, elas continuam intactas
-- (bigint -> text é conversão direta sem perda).
