-- Visit totals for sorting the All-lists directory: each (user, venue on list)
-- counts once. A venue is identified by list_items.name_key; visited rows are
-- per (user_id, name_key). Example: 5 users each marked 10 distinct list venues
-- visited => 50. Duplicate list rows sharing the same name_key do not inflate
-- the count for a single user.
-- ---------------------------------------------------------------------------
create or replace function public.get_list_visit_totals()
returns table (list_id uuid, visit_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select t.list_id, count(*)::bigint as visit_count
  from (
    select distinct li.list_id, li.name_key, v.user_id
    from public.list_items li
    inner join public.lists l on l.id = li.list_id and l.deleted_at is null
    inner join public.visited v on v.name_key = li.name_key
  ) t
  group by t.list_id;
$$;
