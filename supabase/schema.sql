-- Schema for SF Top 100 app.
-- Run this in the Supabase SQL editor (or via `supabase db push`) the first
-- time you wire the project to a new Supabase instance, and re-run anytime
-- you add a new table below.

-- ---------------------------------------------------------------------------
-- visited: per-user set of restaurant names the user has marked visited.
-- Keyed on a normalized name so the same restaurant shows as visited across
-- every list edition it appears on (2026, 2027, …).
-- ---------------------------------------------------------------------------
create table if not exists public.visited (
  user_id  uuid not null references auth.users(id) on delete cascade,
  name     text not null,
  name_key text generated always as (lower(btrim(name))) stored,
  primary key (user_id, name_key)
);

alter table public.visited enable row level security;

drop policy if exists "visited read own or shared" on public.visited;
create policy "visited read own or shared"
  on public.visited for select
  using (
    auth.uid() = user_id
    or exists (select 1 from public.public_lists pl where pl.user_id = visited.user_id)
    or exists (select 1 from public.profiles p where p.user_id = visited.user_id)
    or exists (
      select 1 from public.lists l
      where l.owner_id = visited.user_id and l.deleted_at is null
    )
  );

drop policy if exists "visited write own" on public.visited;
drop policy if exists "visited insert own" on public.visited;
create policy "visited insert own"
  on public.visited for insert
  with check (auth.uid() = user_id);
drop policy if exists "visited update own" on public.visited;
create policy "visited update own"
  on public.visited for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
drop policy if exists "visited delete own" on public.visited;
create policy "visited delete own"
  on public.visited for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- hearted: per-user set of restaurant names the user has favorited. Same
-- shape as `visited` above.
-- ---------------------------------------------------------------------------
create table if not exists public.hearted (
  user_id  uuid not null references auth.users(id) on delete cascade,
  name     text not null,
  name_key text generated always as (lower(btrim(name))) stored,
  primary key (user_id, name_key)
);

alter table public.hearted enable row level security;

drop policy if exists "hearted read own or shared" on public.hearted;
create policy "hearted read own or shared"
  on public.hearted for select
  using (
    auth.uid() = user_id
    or exists (select 1 from public.public_lists pl where pl.user_id = hearted.user_id)
    or exists (select 1 from public.profiles p where p.user_id = hearted.user_id)
    or exists (
      select 1 from public.lists l
      where l.owner_id = hearted.user_id and l.deleted_at is null
    )
  );

drop policy if exists "hearted write own" on public.hearted;
drop policy if exists "hearted insert own" on public.hearted;
create policy "hearted insert own"
  on public.hearted for insert
  with check (auth.uid() = user_id);
drop policy if exists "hearted update own" on public.hearted;
create policy "hearted update own"
  on public.hearted for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
drop policy if exists "hearted delete own" on public.hearted;
create policy "hearted delete own"
  on public.hearted for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- public_lists: opt-in record indicating a user wants their list shared.
-- A row exists iff the user has enabled sharing. The `display` column holds
-- the friendly label (currently the user's email) shown to viewers.
-- ---------------------------------------------------------------------------
create table if not exists public.public_lists (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  display    text,
  created_at timestamptz not null default now()
);

alter table public.public_lists enable row level security;

-- Anyone (including anon) may look up a shared list by user_id.
drop policy if exists "public_lists readable by anyone" on public.public_lists;
create policy "public_lists readable by anyone"
  on public.public_lists for select
  using (true);

-- Only the owner may opt in / out.
drop policy if exists "public_lists owner writes" on public.public_lists;
create policy "public_lists owner writes"
  on public.public_lists for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
