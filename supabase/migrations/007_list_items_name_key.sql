-- Align list row identity with visited/hearted.name_key (Postgres lower(btrim(name))).
-- The client matches progress using this column so rows light up even when JS
-- toLowerCase and DB lower() disagree on edge Unicode, and when the on-screen
-- list comes from the same rows as the All-lists directory query.
-- ---------------------------------------------------------------------------
alter table public.list_items
  add column if not exists name_key text
  generated always as (lower(btrim(name))) stored;
