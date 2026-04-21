-- ---------------------------------------------------------------------------
-- 001_usernames_lists.sql
--
-- Adds usernames, custom lists, list items, geocode cache, and extends
-- visited/hearted with a list_id so the same person can track progress on
-- multiple lists. Additive only: existing rows keep working with list_id
-- NULL until migration 003 backfills them.
--
-- Apply in this order:
--   001_usernames_lists.sql      <-- this file
--   (have kidhack@kidhack.com sign in once)
--   002_seed_default_list.sql
--   (deploy new frontend)
--   003_backfill_list_id.sql
--
-- Reordering the deploy and 003 will produce duplicate (user_id, NULL, rank)
-- and (user_id, default_list_id, rank) rows that fail the post-backfill
-- unique constraint.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- profiles: per-user username used for pretty share URLs (/<username>).
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  username   text unique not null check (username ~ '^[a-zA-Z0-9]{2,32}$'),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are public" on public.profiles;
create policy "profiles are public"
  on public.profiles for select
  using (true);

drop policy if exists "users manage own profile" on public.profiles;
create policy "users manage own profile"
  on public.profiles for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- lists: user-created restaurant lists. The seeded SF Chronicle Top 100
-- lives here too (slug 'chronicle-top-100-2026', owned by kidhack) so the
-- code path is uniform. Soft delete via deleted_at; hard delete is blocked
-- for the default list.
-- ---------------------------------------------------------------------------
create table if not exists public.lists (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users(id) on delete cascade,
  slug       text unique not null check (slug ~ '^[a-zA-Z0-9-]{2,48}$'),
  name       text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists lists_deleted_at_idx
  on public.lists (deleted_at) where deleted_at is null;

alter table public.lists enable row level security;

drop policy if exists "lists are public" on public.lists;
create policy "lists are public"
  on public.lists for select
  using (true);

drop policy if exists "owners manage own lists" on public.lists;
create policy "owners manage own lists"
  on public.lists for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

-- ---------------------------------------------------------------------------
-- prevent_default_list_delete: hard-block deletion of the seeded default
-- list at the database layer. The UI also hides Delete on this slug; this
-- trigger is the backstop in case a future code path slips past the check.
-- ---------------------------------------------------------------------------
create or replace function public.prevent_default_list_delete()
returns trigger
language plpgsql
as $$
begin
  if old.slug = 'chronicle-top-100-2026' then
    raise exception 'The site-wide default list cannot be deleted';
  end if;
  return old;
end;
$$;

drop trigger if exists lists_block_default_delete on public.lists;
create trigger lists_block_default_delete
  before delete on public.lists
  for each row execute function public.prevent_default_list_delete();

-- ---------------------------------------------------------------------------
-- list_items: ranked entries for a list. Max 100 per list (enforced by the
-- rank check + app-layer count). Coordinates are optional so users can save
-- a list before geocoding completes; rows without coords don't render on
-- the map.
-- ---------------------------------------------------------------------------
create table if not exists public.list_items (
  list_id  uuid not null references public.lists(id) on delete cascade,
  rank     int  not null check (rank between 1 and 100),
  name     text not null,
  address  text,
  city     text,
  cuisine  text,
  url      text,
  lat      double precision,
  lng      double precision,
  primary key (list_id, rank)
);

alter table public.list_items enable row level security;

drop policy if exists "list items are public" on public.list_items;
create policy "list items are public"
  on public.list_items for select
  using (true);

drop policy if exists "list owner manages items" on public.list_items;
create policy "list owner manages items"
  on public.list_items for all
  using (
    exists (
      select 1 from public.lists l
      where l.id = list_id and l.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.lists l
      where l.id = list_id and l.owner_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- replace_list_items: atomic replace used by the Edit list flow. Avoids
-- partial-state rows when the user drops or reorders entries.
-- ---------------------------------------------------------------------------
create or replace function public.replace_list_items(
  p_list_id uuid,
  p_items   jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
  owner  uuid;
  item_count int;
begin
  select owner_id into owner from public.lists where id = p_list_id;
  if owner is null then
    raise exception 'list % not found', p_list_id;
  end if;
  if owner <> caller then
    raise exception 'only the list owner may replace items';
  end if;
  item_count := jsonb_array_length(p_items);
  if item_count > 100 then
    raise exception 'a list may not have more than 100 items (got %)', item_count;
  end if;

  delete from public.list_items where list_id = p_list_id;

  insert into public.list_items (list_id, rank, name, address, city, cuisine, url, lat, lng)
  select
    p_list_id,
    (row_number() over ())::int as rank,
    coalesce(elem->>'name', ''),
    elem->>'address',
    elem->>'city',
    elem->>'cuisine',
    elem->>'url',
    nullif(elem->>'lat', '')::double precision,
    nullif(elem->>'lng', '')::double precision
  from jsonb_array_elements(p_items) as elem;

  update public.lists set updated_at = now() where id = p_list_id;
end;
$$;

revoke all on function public.replace_list_items(uuid, jsonb) from public;
grant execute on function public.replace_list_items(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- visited / hearted: extend with list_id so the same user can track
-- progress per list. NULL during the transition (old frontend writes nulls);
-- migration 003 backfills + sets NOT NULL.
--
-- Drop the (user_id, rank) PKs and add a coalesce-based unique index so
-- rows with NULL list_id stay unique by user_id + rank, while rows with a
-- real list_id are unique by (user_id, list_id, rank).
-- ---------------------------------------------------------------------------
alter table public.visited add column if not exists list_id uuid
  references public.lists(id) on delete cascade;
alter table public.hearted add column if not exists list_id uuid
  references public.lists(id) on delete cascade;

alter table public.visited drop constraint if exists visited_pkey;
alter table public.hearted drop constraint if exists hearted_pkey;

create unique index if not exists visited_user_list_rank_idx
  on public.visited (
    user_id,
    coalesce(list_id, '00000000-0000-0000-0000-000000000000'::uuid),
    rank
  );
create unique index if not exists hearted_user_list_rank_idx
  on public.hearted (
    user_id,
    coalesce(list_id, '00000000-0000-0000-0000-000000000000'::uuid),
    rank
  );

-- Update the read policies to also allow viewing rows tied to non-deleted
-- lists. The legacy public_lists join stays in place for the transition so
-- old shared ?u= links keep resolving until the frontend redirect lands.
drop policy if exists "visited read own or shared" on public.visited;
create policy "visited read own or shared"
  on public.visited for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.public_lists pl where pl.user_id = visited.user_id
    )
    or (
      list_id is not null
      and exists (
        select 1 from public.lists l
        where l.id = visited.list_id and l.deleted_at is null
      )
    )
  );

drop policy if exists "hearted read own or shared" on public.hearted;
create policy "hearted read own or shared"
  on public.hearted for select
  using (
    auth.uid() = user_id
    or exists (
      select 1 from public.public_lists pl where pl.user_id = hearted.user_id
    )
    or (
      list_id is not null
      and exists (
        select 1 from public.lists l
        where l.id = hearted.list_id and l.deleted_at is null
      )
    )
  );

-- ---------------------------------------------------------------------------
-- geocode_cache: write-through cache for Nominatim lookups so repeated
-- pastes of the same address don't re-hit the API. Public read/write keeps
-- it simple; rate limiting lives in the client. Rows are not PII.
-- ---------------------------------------------------------------------------
create table if not exists public.geocode_cache (
  query     text primary key,
  lat       double precision not null,
  lng       double precision not null,
  cached_at timestamptz not null default now()
);

alter table public.geocode_cache enable row level security;

drop policy if exists "geocode cache readable" on public.geocode_cache;
create policy "geocode cache readable"
  on public.geocode_cache for select
  using (true);

drop policy if exists "geocode cache insertable" on public.geocode_cache;
create policy "geocode cache insertable"
  on public.geocode_cache for insert
  with check (true);
