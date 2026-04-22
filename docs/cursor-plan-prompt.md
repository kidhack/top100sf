# Cursor Plan Prompt — top100sf.com feature additions

## Context: current state

`index.html` is a single-file app (Leaflet + Supabase JS via esm.sh). It renders the SF Chronicle Top 100 2026 from a hardcoded `RESTAURANTS` array. Users can mark visited (green check) and heart (red) items. Auth is Supabase magic-link OTP. Sharing uses `?u=<uuid>` query param and a `public_lists` table (`user_id`, `display`).

Tables today:
- `visited(user_id, rank)`
- `hearted(user_id, rank)`
- `public_lists(user_id, display)`

Auth overlay lives in `#auth.map-auth`. Signed-in state renders email button + "Share My List" + a share URL section. Signed-out state shows a magic-link form. Viewing someone else's list uses `?u=` and puts the body in `viewing` mode (read-only).

Goal of this change: replace the signed-in overlay with a hamburger menu, add custom usernames for pretty share URLs (`top100sf.com/username`), and let users create their own lists (`top100sf.com/list/listname`) from pasted CSV/JSON. Keep the single-file architecture unless noted.

---

## Work plan

### 0. Split the single file first (prerequisite)

Before any feature work, refactor `index.html` into separate files. No build step, no bundler — native ES modules and plain `<link>` tags.

Target structure:
```
/index.html          — markup, <link rel="stylesheet">, <script type="module" src="./app.js">
/styles.css          — all CSS currently in the <style> block
/app.js              — the entire current <script type="module"> body
/data/restaurants.js — export const RESTAURANTS = [...]; (the hardcoded default list)
```

Rules during the split:
- Keep imports from `esm.sh` as-is (Supabase, and later PapaParse).
- `app.js` should `import { RESTAURANTS } from './data/restaurants.js';` rather than defining it inline.
- Do not introduce TypeScript, bundlers, or a framework. The deploy artifact is still a folder of static files.
- Verify the app renders and all existing features work (auth, share, visited, hearted, view-mode) before starting §1.
- Commit the split as its own change so later feature diffs are readable.

Once the split is in and working, proceed to §1.

### 1. Routing

Switch from `?u=<uuid>` and `?list=<id>` to clean paths:
- `top100sf.com/` — default SF Chronicle Top 100 list (current behavior).
- `top100sf.com/<username>` — that user's view of the default list (visited + hearted overlay). Replaces `?u=<uuid>`.
- `top100sf.com/list/<listslug>` — a user-created list, raw (no overlay).
- `top100sf.com/<username>/<listslug>` — that user's view of a custom list (their visited + hearted overlay on top of the list). This is how you share "my progress on this custom list."

The `/<username>/<listslug>` form works regardless of who owns the list: Alex can share their visits on Bob's list at `/alex/bobs-food-tour` and it resolves correctly (list lookup by slug, overlay by username).

Because the site is served as a static `index.html`, set up SPA fallback routing:
- If hosted on Vercel/Netlify: add `rewrites` so every unknown path serves `index.html`.
- Document the rewrite needed in `README.md` if not already present.
- Client-side parser reads `window.location.pathname` on boot and decides:
  - `/` → default list, signed-in user's own overlay
  - `/list/<slug>` → load custom list by slug, no overlay
  - `/<username>` → treat as username; resolve to `user_id` via `profiles`; load default list with that user's overlay
  - `/<username>/<slug>` → resolve username AND slug; load that list with that user's overlay (read-only if viewer ≠ username's user)
- Slug lookup is globally unique (per schema), so `<slug>` in the two-segment form is resolved the same as in `/list/<slug>`; the `<username>` segment only selects whose overlay to render.
- Keep back-compat: if `?u=<uuid>` is present, redirect to `/<username>` (or `/<username>/<slug>` when combined with `?list=<slug>`) if a username exists; otherwise keep current behavior.
- If either username or slug fails to resolve, show an error state with buttons to `/` and (when username resolved but slug didn't) `/<username>`.

### 2. Database schema additions (Supabase)

Add three tables. Provide SQL migrations inline.

```sql
-- 2a. Usernames
create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null check (username ~ '^[a-zA-Z0-9]{2,32}$'),
  created_at timestamptz default now()
);
alter table profiles enable row level security;
create policy "profiles are public" on profiles for select using (true);
create policy "users manage own profile" on profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2b. Custom lists
create table lists (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  slug text unique not null check (slug ~ '^[a-zA-Z0-9-]{2,48}$'),
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
alter table lists enable row level security;
create policy "lists are public" on lists for select using (true);
create policy "owners manage own lists" on lists
  for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

-- 2c. List items (max 100 per list — enforced in app; trigger optional)
create table list_items (
  list_id uuid not null references lists(id) on delete cascade,
  rank int not null check (rank between 1 and 100),
  name text not null,
  address text,
  city text,
  cuisine text,
  url text,
  lat double precision,
  lng double precision,
  primary key (list_id, rank)
);
alter table list_items enable row level security;
create policy "list items are public" on list_items for select using (true);
create policy "list owner manages items" on list_items
  for all using (
    exists (select 1 from lists l where l.id = list_id and l.owner_id = auth.uid())
  ) with check (
    exists (select 1 from lists l where l.id = list_id and l.owner_id = auth.uid())
  );

-- 2d. Extend visited/hearted to support custom lists
alter table visited add column list_id uuid references lists(id) on delete cascade;
alter table hearted add column list_id uuid references lists(id) on delete cascade;
-- Null list_id = SF Chronicle default list (existing rows stay valid).
-- Drop old PK, add composite that includes list_id (NULL-safe via coalesce workaround or unique index).
create unique index visited_user_list_rank_idx on visited (user_id, coalesce(list_id, '00000000-0000-0000-0000-000000000000'::uuid), rank);
create unique index hearted_user_list_rank_idx on hearted (user_id, coalesce(list_id, '00000000-0000-0000-0000-000000000000'::uuid), rank);
```

Note: review the existing unique/PK constraints on `visited` and `hearted` before the `alter` — the current `onConflict: 'user_id,rank'` upserts will need to change to `'user_id,list_id,rank'`.

**Seed the default list owned by kidhack@kidhack.com.** The SF Chronicle Top 100 should be a real row in `lists` so the owner gets edit/delete options and the code path is uniform (no special "synthetic default" case). Slug: `chronicle-top-100-2026`. The `/` route resolves to this slug.

Because `kidhack@kidhack.com` must already exist in `auth.users` (i.e. they have signed in at least once), run this as a separate migration *after* the account exists:

```sql
-- 2e. Seed the default list (run after kidhack@kidhack.com has signed in at least once)
do $$
declare
  owner uuid;
  new_list_id uuid;
begin
  select id into owner from auth.users where email = 'kidhack@kidhack.com';
  if owner is null then
    raise exception 'kidhack@kidhack.com has not signed in yet — have them sign in, then rerun this migration';
  end if;

  -- Ensure profile exists (username required by schema)
  insert into profiles (user_id, username)
  values (owner, 'kidhack')
  on conflict (user_id) do nothing;

  insert into lists (owner_id, slug, name)
  values (owner, 'chronicle-top-100-2026', 'SF Chronicle Top 100 Bay Area Restaurants 2026')
  on conflict (slug) do update set name = excluded.name
  returning id into new_list_id;

  -- Bulk insert the 100 restaurants. Cursor should paste the full array here,
  -- pulled from data/restaurants.js — one insert per rank.
  -- Example (Cursor: expand to all 100):
  insert into list_items (list_id, rank, name, address, city, cuisine, url, lat, lng) values
    (new_list_id, 1, 'Four Kings', '710 Commercial St.', 'San Francisco', 'Cantonese', 'https://www.itsfourkings.com/', 37.794093, -122.405068),
    (new_list_id, 2, 'The Progress', '1525 Fillmore St.', 'San Francisco', 'Californian', 'https://theprogress-sf.com/', 37.783661, -122.433076)
    -- ... ranks 3–100 ...
  on conflict (list_id, rank) do update set
    name = excluded.name, address = excluded.address, city = excluded.city,
    cuisine = excluded.cuisine, url = excluded.url, lat = excluded.lat, lng = excluded.lng;
end $$;
```

Cursor should generate the full 100-row `values (...)` block from `data/restaurants.js` as part of this migration. Keep a script (e.g. `scripts/generate-default-list-sql.js`) that can regenerate this seed file from the data module, so it stays reproducible.

Implications downstream:
- `/` is just an alias for `/list/chronicle-top-100-2026`. The router can redirect, or the loader can resolve `/` → that slug internally. Prefer the internal resolve so the URL stays clean.
- The "All lists" directory (§5) no longer needs a synthetic SF Chronicle row — the default is a real `lists` entry and shows up naturally. Owner field will read "kidhack" from `profiles`.
- When kidhack is signed in, the list menu on `/` shows Edit + Delete (§6). Deleting the default list should be guarded — see §8.

**2f. Backfill existing visited/hearted rows (run after 2e).** Every existing `visited`/`hearted` row has `list_id = null`. Once the app starts sending `list_id` for default-list writes, null rows become orphaned. Backfill them:

```sql
-- 2f. Backfill null list_id to point at the default list
do $$
declare default_list uuid;
begin
  select id into default_list from lists where slug = 'chronicle-top-100-2026';
  update visited set list_id = default_list where list_id is null;
  update hearted set list_id = default_list where list_id is null;
end $$;
-- Then make list_id required going forward:
alter table visited alter column list_id set not null;
alter table hearted alter column list_id set not null;
-- And drop the coalesce-based unique indexes in favor of plain composite uniques:
drop index if exists visited_user_list_rank_idx;
drop index if exists hearted_user_list_rank_idx;
alter table visited add constraint visited_user_list_rank_key unique (user_id, list_id, rank);
alter table hearted add constraint hearted_user_list_rank_key unique (user_id, list_id, rank);
```

**2g. Soft-delete lists (avoid cascading progress loss).** `on delete cascade` on `lists` would wipe every viewer's visited/hearted for that list with no undo. Add a soft-delete column and filter in app:

```sql
alter table lists add column deleted_at timestamptz;
create index lists_deleted_at_idx on lists(deleted_at) where deleted_at is null;
```

All `select` queries against `lists` (directory, loader, slug lookup) must add `where deleted_at is null`. "Delete list" sets `deleted_at = now()` instead of `delete`. Add a 30-day cleanup job later; not MVP.

**2h. Deprecate `public_lists.display` in favor of `profiles.username`.** The two overlap. The clean cut: sharing uses `profiles.username` when present, falls back to `public_lists` only for legacy users who haven't picked a username. New code should not write to `public_lists.display` — leave the table for read-only back-compat. Drop the column in a follow-up migration once no usernameless users remain.

### 3. Hamburger menu (signed-in overlay replacement)

Replace `renderAuthSignedIn()` output with a hamburger button (three-line icon) that opens a dropdown anchored to the top-right of the map. Keep position, z-index, and glass background of today's `.map-auth`.

**Menu items (in order):**
1. **Username row** — shows `@username` if set, otherwise the email. Clicking opens a "Set username" sub-panel with:
   - Input (pattern `[a-zA-Z0-9]{2,32}`, live validation, show count)
   - Availability check: debounced (350ms) `select count(*) from profiles where username = ?`
   - "Save" upserts into `profiles` (server enforces uniqueness)
   - On save: update the share URL the menu exposes, update `public_lists.display` to the new username so viewers see it
2. **Share this list** — opens the share panel with two options when applicable:
   - **Share the list itself** (raw, no overlay): `top100sf.com/` for default, `top100sf.com/list/<slug>` for custom. Anyone opening the link sees the list with no one's progress.
   - **Share my progress on this list** (shown only when signed in with a username set, and only if the viewer has any visited/hearted items): `top100sf.com/<username>` for default, `top100sf.com/<username>/<slug>` for custom. Viewer sees the list with the sharer's overlay, read-only.
   If no username is set, show a hint/nudge ("Pick a username for a pretty share URL") and fall back to the `?u=<uuid>` form for the "my progress" link. Copy button behavior is unchanged.
3. **All lists** — opens a list directory panel (see §5).
4. **New list** — opens the new-list modal (see §4).
5. **Sign out** — existing `confirmDialog({...})` flow, then `supabase.auth.signOut()`.

Keep the signed-out view as is (`Sign in to sync` → magic link form).

Accessibility:
- `<button aria-haspopup="menu" aria-expanded>` trigger
- Menu opens in a `<ul role="menu">` with `role="menuitem"` buttons
- Close on Escape, outside click, and after an action
- Trap focus when open on mobile

Visual: borrow existing tokens (`--border`, `--fg`, `--hover`). Don't introduce a new design system; it should feel like the current UI.

**Mobile:** at ≤720px, render the menu as a bottom sheet (slide up from bottom, full-width) rather than a dropdown. The current `.map-auth` overlay is cramped on phones; a bottom sheet gives room for the username editor and is more thumb-friendly. Use a simple `<dialog>` styled with `margin-top: auto` and a slide-in transition.

### 4. New-list modal

Convert the existing `<dialog id="confirm-dialog">` pattern into a second `<dialog id="new-list-dialog">`. Fields:

- **List name** — `text`, 1–80 chars, required.
- **Slug preview** — live-generated from name (lowercase, strip non-alphanumeric, collapse hyphens), editable, `[a-zA-Z0-9-]{2,48}`. Show `top100sf.com/list/<slug>` under the field. Availability check against `lists.slug` (debounced).
- **Format toggle** — `CSV` / `JSON` radio.
- **Template link** — clicking fills the textarea with an example. Exact templates:

```json
[
  {"name":"Four Kings","address":"710 Commercial St.","city":"San Francisco","cuisine":"Cantonese","url":"https://www.itsfourkings.com/","lat":37.794093,"lng":-122.405068}
]
```

```csv
name,address,city,cuisine,url,lat,lng
Four Kings,710 Commercial St.,San Francisco,Cantonese,https://www.itsfourkings.com/,37.794093,-122.405068
```

- **Items textarea** — paste target. Parser accepts either format. Required columns: `name`. Optional: `address`, `city`, `cuisine`, `url`, `lat`, `lng`.
- **Flexible column matching.** Case-insensitive. Support common aliases so paste-from-spreadsheet "just works":
  - `name` ← `Name`, `restaurant`, `title`
  - `address` ← `Address`, `street`, `address1`, `location`
  - `city` ← `City`, `town`
  - `cuisine` ← `Cuisine`, `category`, `type`
  - `url` ← `URL`, `website`, `link`
  - `lat` ← `Latitude`, `lat`, `y`
  - `lng` ← `Longitude`, `lng`, `lon`, `long`, `x`
  Unknown columns are ignored with an info note.
- **Validation summary** — "parsed N items" (green), "X errors" (red, expandable), **hard cap at 100** (reject the 101st with an inline error). If `lat`/`lng` missing for any rows, surface a "Geocode N addresses?" button (see §4a).
- **Create button** — disabled until name + slug valid + at least 1 item parsed, and either every row has coords or the user has explicitly accepted "create anyway, these rows won't appear on the map."
  - Insert into `lists`, then bulk insert into `list_items` with `rank = index+1`.
  - On success: close modal, navigate to `/list/<slug>`.

CSV parsing: use PapaParse (import from `https://esm.sh/papaparse@5`) with `header: true, skipEmptyLines: true`. Coerce `lat`/`lng` to numbers. Normalize headers to lowercase + alias-map before mapping rows.

### 4a. Geocoding (required for usability)

Without lat/lng, list items don't render on the map — which is the point of the site. Make geocoding a first-class part of paste.

**UX flow in the new-list modal:**
1. On parse, count rows missing coords. If >0, show "12 of 40 need coordinates — [Geocode addresses]."
2. Clicking runs geocoding with a visible progress bar ("Geocoding 3 of 12…"). Do it client-side, one request/sec to respect the free tier.
3. Each result fills the row's `lat`/`lng` in-memory. Failed rows are highlighted red with a "Couldn't find — edit address?" hint and an inline editable address field.
4. User can re-geocode failed rows after editing, or skip them (they save but won't render on the map).

**Provider:** Nominatim (OpenStreetMap) for MVP — free, no API key, 1 req/sec rate limit. Endpoint:
```
https://nominatim.openstreetmap.org/search?format=json&q=<name>,<address>,<city>,CA,USA&limit=1
```
Set a `User-Agent` header (required by their ToS) — "top100sf.com geocoder (contact: alexanderblambert@gmail.com)".

**Cache:** persist successful geocodes in a `geocode_cache(query text primary key, lat double precision, lng double precision, cached_at timestamptz)` table so repeated pastes of the same address don't re-hit Nominatim. Write-through cache: check table first, then network.

**Upgrade path:** if Nominatim gets flaky or rate-limited, swap to a Supabase Edge Function that calls Mapbox (paid but higher-quality geocoding). Keep the client interface the same so this is a one-file swap.

### 5. List directory ("All lists")

Panel/modal listing every list in the system. Columns:
- List name (links to `/list/<slug>` or `/` for the default)
- Item count (from `list_items` aggregate, or `100` for default)
- Owner (username from `profiles`, or "SF Chronicle" for the default)
- Your progress: `visited/total` green dot if current user has any visited items on that list

Query:
```sql
select l.id, l.slug, l.name, p.username as owner,
       (select count(*) from list_items where list_id = l.id) as item_count
from lists l
join profiles p on p.user_id = l.owner_id
order by l.created_at desc
limit 200;
```

Then a second query for `visited` grouped by `list_id` scoped to current user, merged client-side. Prepend a synthetic entry for the default list (`/`, owner "SF Chronicle", 100 items).

Later we'll paginate; 200 is fine for MVP.

### 6. List menu options (viewing a list)

When viewing any list (default or custom), the hamburger menu shows a context-aware "This list" section:

**Everyone sees:**
- Share this list (raw) — `/` or `/list/<slug>`
- Share my progress (signed-in only, gated on having visited/hearted items) — `/<username>` or `/<username>/<slug>`

**Owner-only (extra items, shown only when `currentUser.id === list.owner_id`):**
- **Edit list** — opens an edit modal with the same fields as New List pre-filled; "Save" updates `lists.name`/`slug` and diff-applies `list_items` (for simplicity: delete-all + re-insert inside a transaction via an RPC).
- **Delete list** — `confirmDialog` then `delete from lists where id = ?`. On success, navigate to `/`.

Default list (`/`) has no owner → never shows edit/delete.

### 7. Loading a custom list

Factor out the hardcoded `RESTAURANTS` array into a `loadList(routeContext)` function:
- `routeContext = { kind: 'default' }` → resolve internally to slug `chronicle-top-100-2026` and load via the same path as any custom list
- `routeContext = { kind: 'user', username }` → resolve username → user_id, load the default list (`chronicle-top-100-2026`), then load their `visited`/`hearted` as the overlay (as today)
- `routeContext = { kind: 'list', slug }` → fetch `lists` + `list_items` (ordered by `rank`) → build the runtime restaurants array from that, no overlay
- `routeContext = { kind: 'user-list', username, slug }` → resolve both; load the list by slug AND that user's `visited`/`hearted` scoped to `list_id`; read-only if viewer ≠ username's user

The hardcoded `RESTAURANTS` array in `data/restaurants.js` stays as the canonical seed source (used to regenerate the SQL in §2e and as a fallback if Supabase is unreachable on first paint), but the running app reads from `list_items` for every list, including the default.

**Optimistic first paint for `/`.** Today `/` renders instantly because the array is inline. After this change it would block on a Supabase round-trip — a regression. Fix:

1. If the route is `/` or a known-default username path, immediately render pins + rows from `data/restaurants.js`.
2. Kick off the `list_items` fetch in parallel.
3. When the fetch resolves, diff against the hardcoded version. If different (shouldn't happen in practice), update in place. Do not flash or re-render wholesale.
4. Visited/hearted overlay still requires the auth check — fine to fill in after first paint as today.

For `/list/<slug>` and `/<username>` we accept a loading state (brief skeleton) since there's no hardcoded fallback.

All downstream code (`rowEls`, `markers`, `select()`, `toggleVisited`, `toggleHeart`) should read from one `restaurants` variable rather than the module-level constant. Visited/hearted queries must pass `list_id` (null for default).

### 8. Edge cases to handle

- Username already taken: show error on save, keep modal open.
- Username contains invalid chars: inline validation, disable Save.
- Slug collision on create: regenerate with `-2`, `-3` suffix suggestion, or ask user to edit.
- CSV with a quoted comma: PapaParse handles this — include a test row in the template.
- Paste >100 rows: reject with "Max 100 items per list. You pasted N." and show the extras as highlighted rows.
- User who owns the default list has no entry in `lists` — directory must merge the synthetic "SF Chronicle" row.
- Backward-compat: old `?u=<uuid>` share links should still resolve.
- Reserved slugs: block `list`, `admin`, `api`, `about`, `privacy`, `signin`, `signout`, `_next`, `assets` for both usernames and list slugs.
- Guard against deleting the default list: even though kidhack owns `chronicle-top-100-2026`, the Delete button on `/` should require a second confirmation mentioning "this is the site-wide default list" and, ideally, also require typing the slug to confirm. Alternatively, hide Delete (but keep Edit) when the slug is `chronicle-top-100-2026` and only expose delete from `/list/chronicle-top-100-2026` with the extra guard. Pick one and document it in `CHANGES.md`.
- Username namespace collisions: flat `/<username>` risks future page conflicts (`/pricing`, `/blog`, etc.). Reserved list covers what we know today, but keep an eye on it — if the marketing site ever needs more routes, we may need to migrate users to `/u/<username>` later. Note in `CHANGES.md`.
- Per-user list cap: enforce 20 custom lists per user at the app layer (simple `count(*)` check before insert). Prevents accidental spam. Easy to bump later.
- Viewer overlay on custom lists: when a non-owner visits `/list/<slug>`, they can still toggle visited/hearted — those rows save under `(viewer_user_id, list_id, rank)`. Make this explicit in the UI: the check/heart icons should be active and a subtle hint says "Tracking your visits to <list name>." Visited/hearted counts in the column headers show the viewer's own counts, not the owner's.

### 9. Testing checklist

- Sign in, pick username "alex", land on `/alex` → see own overlay.
- Visit `/alex` while signed out → see read-only version.
- Create list "Date Nights" → lands on `/list/date-nights`, pins render from pasted data.
- Mark items visited on `/list/date-nights`, then use "Share my progress" → copies `/alex/date-nights`; opening that URL in incognito shows Alex's overlay read-only.
- Non-owner (bob) opens `/list/date-nights` → can mark own visits; "Share my progress" shares `/bob/date-nights`.
- Non-owner opens `/list/date-nights` → only "Share this list" option visible.
- Owner opens the same list → Edit + Delete options visible.
- Delete list while viewing it → soft-deletes, redirects to `/`.
- Paste 101 rows → 101st rejected.
- Paste malformed JSON → error shown, no insert.
- Paste CSV with header "Name,Address,City" (capital case) → parses correctly via alias map.
- Paste CSV without lat/lng → "Geocode N addresses?" appears; clicking runs Nominatim with progress bar; failed rows highlighted editable.
- Backward compat: `?u=<uuid>` still works and redirects to `/<username>` when a username is set.
- Reserved slug "admin" rejected on both username and list-slug inputs.
- First paint on `/` is instant (from hardcoded fallback) even with Supabase slow.
- Existing user with visited items from before the migration sees their checks preserved after deploy (backfill worked).
- 21st list creation attempt blocked with "20 lists max" error.
- Mobile (≤720px): hamburger opens as a bottom sheet, not a dropdown.

### 10. Deliverables from Cursor

1. The file split from §0 as a first, standalone commit (`index.html`, `styles.css`, `app.js`, `data/restaurants.js`).
2. Feature commits on top of the split, grouped by section (§1 routing + §2 schema together, then §3, §4, §5, §6). Each commit should be independently reviewable.
3. `supabase/migrations/00X_usernames_lists.sql` with the SQL from §2a–2d + 2g.
4. `supabase/migrations/00Y_seed_default_list.sql` with §2e (run after kidhack has signed in).
5. `supabase/migrations/00Z_backfill_list_id.sql` with §2f (run after the frontend deploys).
6. `scripts/generate-default-list-sql.js` to regenerate the seed from `data/restaurants.js`.
7. `vercel.json` (or equivalent rewrite config) adding SPA fallback.
8. A short `CHANGES.md` explaining routing changes, deploy order, and how to apply each migration.

### 10a. Deploy order (critical — gets writes wrong if shuffled)

Run in this exact sequence:

1. **Migration 00X** (schema) — additive only; safe to run against prod with old frontend still deployed. Old clients keep writing `list_id = null`.
2. **Have kidhack sign in** — ensures `auth.users` row exists.
3. **Migration 00Y** (seed default list) — creates the `lists` row and all 100 `list_items`. Site still works on old frontend because it doesn't query these yet.
4. **Deploy new frontend** — now writes include `list_id`. New writes land correctly; historical null rows are still there.
5. **Migration 00Z** (backfill) — updates historical null rows to point at the default list, then locks `list_id NOT NULL`. Safe because step 4 guarantees no new null writes.

If you reverse 4 and 5, any user who toggles visited between the migrations ends up with a duplicate row (`(user_id, null, rank)` and `(user_id, default_list_id, rank)`), and step 5 will fail on the unique constraint.

### 11. Out of scope (do not build)

- Collaborative lists (multi-owner).
- Comments or notes on list items.
- List forking / duplication ("save a copy").
- Monetization, auth providers beyond existing magic-link.
- Per-list Open Graph / Twitter cards. SPA can't serve per-route meta tags without prerendering. Acceptable limitation for MVP — every shared list shows the default preview. Future fix: Vercel Edge Function that intercepts crawler user-agents and renders `<meta>` tags from `lists`/`list_items`. Note this in `CHANGES.md`.
- Abuse/moderation tooling. §8 enforces a 20-list-per-user cap at the app layer, which is enough for MVP. Admin deletion, reports, and content moderation come later if the site grows.
- Automatic geocoding via Mapbox (Nominatim is MVP; Mapbox is the upgrade path per §4a).

---

## How to use this prompt in Cursor

1. Open the repo in Cursor, open `index.html`.
2. Paste this entire document into Cursor's composer (Cmd-I → Agent mode).
3. Start with §0 (the split) and stop there. Verify the app works end-to-end before doing anything else.
4. Then §2 (schema) + §1 (routing) together, then §3 (menu), then §4, §5, §6 in order.
5. Review each diff before accepting. Push the SQL migration to Supabase via the dashboard SQL editor before deploying the frontend.
