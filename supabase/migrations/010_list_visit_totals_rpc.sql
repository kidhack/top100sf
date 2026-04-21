-- Aggregate how often list venues appear in any user's visited set (one row
-- per matching list_item × user). Used by the All lists directory for sorting.
-- ---------------------------------------------------------------------------
create or replace function public.get_list_visit_totals()
returns table (list_id uuid, visit_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select li.list_id, count(*)::bigint as visit_count
  from public.list_items li
  inner join public.lists l on l.id = li.list_id and l.deleted_at is null
  inner join public.visited v on v.name_key = li.name_key
  group by li.list_id;
$$;

revoke all on function public.get_list_visit_totals() from public;
grant execute on function public.get_list_visit_totals() to anon, authenticated;
