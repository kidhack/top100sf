-- Replace FOR ALL write policies with INSERT/UPDATE/DELETE only so SELECT is
-- governed solely by the read policies (avoids stacking a redundant SELECT rule
-- from "write own" on some Postgres/Supabase setups).
-- Idempotent: safe if granular policies already exist (partial migration / retry).
-- ---------------------------------------------------------------------------
drop policy if exists "visited write own" on public.visited;
drop policy if exists "visited insert own" on public.visited;
drop policy if exists "visited update own" on public.visited;
drop policy if exists "visited delete own" on public.visited;
create policy "visited insert own"
  on public.visited for insert
  with check (auth.uid() = user_id);
create policy "visited update own"
  on public.visited for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "visited delete own"
  on public.visited for delete
  using (auth.uid() = user_id);

drop policy if exists "hearted write own" on public.hearted;
drop policy if exists "hearted insert own" on public.hearted;
drop policy if exists "hearted update own" on public.hearted;
drop policy if exists "hearted delete own" on public.hearted;
create policy "hearted insert own"
  on public.hearted for insert
  with check (auth.uid() = user_id);
create policy "hearted update own"
  on public.hearted for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
create policy "hearted delete own"
  on public.hearted for delete
  using (auth.uid() = user_id);
