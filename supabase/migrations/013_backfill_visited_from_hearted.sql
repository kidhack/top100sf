-- Backfill `visited` from `hearted` when a user favorited a place but has no
-- matching visit row (same user_id + name_key). Fixes accounts affected by
-- optimistic UI / failed visit upserts while hearts persisted.
--
-- Idempotent: safe to re-run; skips rows that already exist in `visited`.
-- Apply via `supabase db push` or paste into the Supabase SQL editor.

insert into public.visited (user_id, name)
select h.user_id, h.name
from public.hearted h
where not exists (
  select 1
  from public.visited v
  where v.user_id = h.user_id
    and v.name_key = h.name_key
)
on conflict (user_id, name_key) do nothing;
