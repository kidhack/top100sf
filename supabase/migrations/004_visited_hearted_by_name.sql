-- 004_visited_hearted_by_name.sql
--
-- Re-key visited/hearted from (user_id, list_id, rank) to (user_id, name_key)
-- so progress is portable across list editions. A user who marks "Via Carota"
-- visited on the 2026 list now sees it as visited on the 2027 list too, and
-- reordering a list no longer shifts their visited state onto the wrong row.
--
-- name_key = lower(btrim(name)), computed via a generated column so trivial
-- variations ("Via Carota" vs "via carota " vs "VIA  CAROTA") collapse into
-- a single entry per user.
--
-- This migration is destructive for data that can't be resolved to a name
-- (orphaned rows with list_id pointing at a deleted list), but after 003
-- backfilled list_id everywhere that shouldn't happen in practice.

-- ---------------------------------------------------------------------------
-- 1. Add the `name` column (nullable during backfill).
-- ---------------------------------------------------------------------------
alter table public.visited add column if not exists name text;
alter table public.hearted add column if not exists name text;

-- ---------------------------------------------------------------------------
-- 2. Backfill `name` from list_items via (list_id, rank).
-- ---------------------------------------------------------------------------
update public.visited v
set name = li.name
from public.list_items li
where v.name is null
  and v.list_id is not null
  and li.list_id = v.list_id
  and li.rank = v.rank;

update public.hearted h
set name = li.name
from public.list_items li
where h.name is null
  and h.list_id is not null
  and li.list_id = h.list_id
  and li.rank = h.rank;

-- ---------------------------------------------------------------------------
-- 3. Pre-migration-003 rows may still have list_id IS NULL; try resolving
--    those against the seeded default list by rank.
-- ---------------------------------------------------------------------------
update public.visited v
set name = li.name
from public.list_items li
join public.lists l on l.id = li.list_id
where v.name is null
  and v.list_id is null
  and l.slug = 'chronicle-top-100-2026'
  and li.rank = v.rank;

update public.hearted h
set name = li.name
from public.list_items li
join public.lists l on l.id = li.list_id
where h.name is null
  and h.list_id is null
  and l.slug = 'chronicle-top-100-2026'
  and li.rank = h.rank;

-- ---------------------------------------------------------------------------
-- 4. Drop any rows we still can't resolve (orphaned).
-- ---------------------------------------------------------------------------
delete from public.visited where name is null;
delete from public.hearted where name is null;

-- ---------------------------------------------------------------------------
-- 5. Drop the (user_id, list_id, rank) unique indexes.
-- ---------------------------------------------------------------------------
drop index if exists public.visited_user_list_rank_idx;
drop index if exists public.hearted_user_list_rank_idx;

-- ---------------------------------------------------------------------------
-- 6. Deduplicate rows that collapse to the same (user_id, name_key) after
--    dropping list_id (same restaurant marked visited on multiple lists).
-- ---------------------------------------------------------------------------
delete from public.visited v1
using public.visited v2
where v1.ctid < v2.ctid
  and v1.user_id = v2.user_id
  and lower(btrim(v1.name)) = lower(btrim(v2.name));

delete from public.hearted h1
using public.hearted h2
where h1.ctid < h2.ctid
  and h1.user_id = h2.user_id
  and lower(btrim(h1.name)) = lower(btrim(h2.name));

-- ---------------------------------------------------------------------------
-- 6b. Remote installs may have policies / uniqueness on list_id that block
--     dropping those columns (e.g. "visited read public"). Remove them here.
-- ---------------------------------------------------------------------------
drop policy if exists "visited read public" on public.visited;
drop policy if exists "hearted read public" on public.hearted;

alter table public.visited drop constraint if exists visited_list_id_fkey;
alter table public.hearted drop constraint if exists hearted_list_id_fkey;

alter table public.visited drop constraint if exists visited_user_list_rank_key;
alter table public.hearted drop constraint if exists hearted_user_list_rank_key;

-- ---------------------------------------------------------------------------
-- 7. Drop legacy columns. visited/hearted is now user-global.
-- ---------------------------------------------------------------------------
alter table public.visited drop column if exists list_id;
alter table public.visited drop column if exists rank;
alter table public.hearted drop column if exists list_id;
alter table public.hearted drop column if exists rank;

-- ---------------------------------------------------------------------------
-- 8. Enforce NOT NULL on name and add the generated dedup key.
-- ---------------------------------------------------------------------------
alter table public.visited alter column name set not null;
alter table public.hearted alter column name set not null;

alter table public.visited
  add column if not exists name_key text
  generated always as (lower(btrim(name))) stored;
alter table public.hearted
  add column if not exists name_key text
  generated always as (lower(btrim(name))) stored;

-- ---------------------------------------------------------------------------
-- 9. New primary key on (user_id, name_key).
-- ---------------------------------------------------------------------------
alter table public.visited add primary key (user_id, name_key);
alter table public.hearted add primary key (user_id, name_key);

-- ---------------------------------------------------------------------------
-- 10. Refresh read RLS. Progress is no longer scoped by list_id, so we open
--     visibility to:
--       - the owner (always),
--       - anyone, if the user has opted into sharing via public_lists,
--       - anyone, if the user owns at least one non-deleted list (their
--         progress is already reachable via /username[/slug] overlays).
-- ---------------------------------------------------------------------------
drop policy if exists "visited read own or shared" on public.visited;
create policy "visited read own or shared"
  on public.visited for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.public_lists pl
      where pl.user_id = visited.user_id
    )
    or exists (
      select 1 from public.profiles p
      where p.user_id = visited.user_id
    )
    or exists (
      select 1 from public.lists l
      where l.owner_id = visited.user_id
        and l.deleted_at is null
    )
  );

drop policy if exists "hearted read own or shared" on public.hearted;
create policy "hearted read own or shared"
  on public.hearted for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.public_lists pl
      where pl.user_id = hearted.user_id
    )
    or exists (
      select 1 from public.profiles p
      where p.user_id = hearted.user_id
    )
    or exists (
      select 1 from public.lists l
      where l.owner_id = hearted.user_id
        and l.deleted_at is null
    )
  );
