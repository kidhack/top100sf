-- Platform visit count for a fixed set of venue name_keys (e.g. bundled default
-- list when no lists row exists). Matches get_list_visit_totals semantics:
-- one per distinct (user_id, name_key) among keys that appear in visited.
-- ---------------------------------------------------------------------------
create or replace function public.visit_count_for_name_keys(p_name_keys text[])
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select count(*)::bigint
      from (
        select distinct v.user_id, v.name_key
        from public.visited v
        where v.name_key = any(p_name_keys)
      ) t
    ),
    0::bigint
  );
$$;

revoke all on function public.visit_count_for_name_keys(text[]) from public;
grant execute on function public.visit_count_for_name_keys(text[]) to anon, authenticated;
