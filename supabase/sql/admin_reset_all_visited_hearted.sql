-- ---------------------------------------------------------------------------
-- ADMIN ONLY — run manually in Supabase → SQL Editor (as postgres).
--
-- Deletes every row in `visited` and `hearted` for all users. Use when you
-- intentionally reset progress (e.g. bad data / key mismatch). Cannot be
-- undone from the app.
--
-- Afterward: signed-in users see empty progress; visitors using localStorage
-- on `/` should clear site data or run in console:
--   localStorage.removeItem('sf100_visited_v2');
--   localStorage.removeItem('sf100_hearted_v2');
-- ---------------------------------------------------------------------------

begin;

delete from public.visited;
delete from public.hearted;

commit;

-- Verify:
-- select (select count(*) from public.visited) as visited_rows,
--        (select count(*) from public.hearted) as hearted_rows;
