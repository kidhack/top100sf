-- Shared Google Place cache + optional place_id on list items.
-- ---------------------------------------------------------------------------
create table if not exists public.places (
  place_id  text primary key,
  name      text not null,
  address   text,
  city      text,
  cuisine   text,
  url       text,
  lat       double precision,
  lng       double precision,
  types     text[],
  updated_at timestamptz not null default now()
);

create index if not exists places_name_ilike_idx on public.places (lower(name));

alter table public.places enable row level security;

drop policy if exists "places readable" on public.places;
create policy "places readable"
  on public.places for select
  using (true);

drop policy if exists "places insertable" on public.places;
create policy "places insertable"
  on public.places for insert
  to authenticated
  with check (true);

drop policy if exists "places updatable" on public.places;
create policy "places updatable"
  on public.places for update
  to authenticated
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
alter table public.list_items add column if not exists place_id text;

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

  insert into public.list_items (list_id, rank, name, address, city, cuisine, url, lat, lng, place_id)
  select
    p_list_id,
    (row_number() over ())::int as rank,
    coalesce(elem->>'name', ''),
    elem->>'address',
    elem->>'city',
    elem->>'cuisine',
    elem->>'url',
    nullif(elem->>'lat', '')::double precision,
    nullif(elem->>'lng', '')::double precision,
    nullif(elem->>'place_id', '')
  from jsonb_array_elements(p_items) as elem;

  update public.lists set updated_at = now() where id = p_list_id;
end;
$$;
