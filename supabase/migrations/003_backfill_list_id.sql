-- ---------------------------------------------------------------------------
-- 003_backfill_list_id.sql
--
-- Run AFTER the new frontend has been deployed to production. The new
-- frontend always writes list_id, so by the time you run this nothing new
-- is going to land with list_id = null. Sequence:
--
--   1. Apply 001_usernames_lists.sql
--   2. Have kidhack@kidhack.com sign in once (creates the auth.users row)
--   3. Apply 002_seed_default_list.sql
--   4. Deploy the new frontend to Dreamhost
--   5. Apply this file (003_backfill_list_id.sql)
--
-- Reversing 4 and 5 lets users with no profile row toggle visited between
-- the migrations and end up with both (user_id, null, rank) and
-- (user_id, default_list_id, rank). The dedupe block below handles a
-- best-effort cleanup in case that ever happened.
-- ---------------------------------------------------------------------------

do $$
declare
  default_list uuid;
begin
  select id into default_list from public.lists where slug = 'chronicle-top-100-2026';
  if default_list is null then
    raise exception 'default list not seeded yet -- run 002_seed_default_list.sql first';
  end if;

  -- If a user has both a null and a default-list row for the same rank
  -- (possible if the new frontend went live before this backfill), drop
  -- the null one. The post-deploy row carries the user's most recent intent.
  delete from public.visited v
  where v.list_id is null
    and exists (
      select 1 from public.visited v2
      where v2.user_id = v.user_id
        and v2.list_id = default_list
        and v2.rank = v.rank
    );
  delete from public.hearted h
  where h.list_id is null
    and exists (
      select 1 from public.hearted h2
      where h2.user_id = h.user_id
        and h2.list_id = default_list
        and h2.rank = h.rank
    );

  update public.visited set list_id = default_list where list_id is null;
  update public.hearted set list_id = default_list where list_id is null;
end $$;

alter table public.visited alter column list_id set not null;
alter table public.hearted alter column list_id set not null;

-- Drop the transitional coalesce-based unique indexes from 001 in favor of
-- plain (user_id, list_id, rank) uniqueness now that nulls are gone.
drop index if exists public.visited_user_list_rank_idx;
drop index if exists public.hearted_user_list_rank_idx;

alter table public.visited
  add constraint visited_user_list_rank_key unique (user_id, list_id, rank);
alter table public.hearted
  add constraint hearted_user_list_rank_key unique (user_id, list_id, rank);

-- Tighten read policies: drop the legacy public_lists join. All lists are
-- public by design, so per-user progress on a non-deleted list is also
-- public (a user opts in by sharing their /<username> URL, which is itself
-- public information).
drop policy if exists "visited read own or shared" on public.visited;
create policy "visited read public"
  on public.visited for select
  using (
    exists (
      select 1 from public.lists l
      where l.id = visited.list_id and l.deleted_at is null
    )
  );

drop policy if exists "hearted read own or shared" on public.hearted;
create policy "hearted read public"
  on public.hearted for select
  using (
    exists (
      select 1 from public.lists l
      where l.id = hearted.list_id and l.deleted_at is null
    )
  );

-- Note: public_lists is intentionally left in place for back-compat with
-- old ?u=<uuid> share links that point at users who never picked a
-- username. A follow-up migration can deprecate it after we audit usage.
