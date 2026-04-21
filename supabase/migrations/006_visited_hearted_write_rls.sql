-- 006: Allow signed-in users to INSERT/UPDATE/DELETE their own visited & hearted rows.
--
-- Migration 004 only recreated SELECT policies. Projects bootstrapped from repo
-- migrations (without running supabase/schema.sql) had RLS enabled but no write
-- policy — every upsert failed with permission denied / empty error.
--
-- Also drop legacy read policies from 003 that referenced list_id (removed in 004)
-- if they somehow still exist on an old branch DB.
-- ---------------------------------------------------------------------------
drop policy if exists "visited read public" on public.visited;
drop policy if exists "hearted read public" on public.hearted;

drop policy if exists "visited write own" on public.visited;
create policy "visited write own"
  on public.visited
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "hearted write own" on public.hearted;
create policy "hearted write own"
  on public.hearted
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
