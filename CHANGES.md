# Changes

## Usernames + custom lists (this PR)

This release reshapes top100sf.com from "one site-wide list with `?u=<uuid>`
share links" into a multi-list app with usernames and pretty URLs.

### What changed

- **File layout.** `index.html` was split into `index.html`, `styles.css`,
  `app.js`, and `data/restaurants.js`. Native ES modules; no bundler. The
  `npm run dist` script copies all four files plus `.htaccess` into `dist/`.
- **Routing.** Client-side router parses `window.location.pathname` into
  one of `default`, `list`, `user`, or `user-list`. URLs:
  - `/` — SF Chronicle Top 100, the signed-in viewer's overlay
  - `/list/<slug>` — any custom list, the signed-in viewer's overlay
  - `/<username>` — SF Chronicle Top 100, that user's overlay (read-only
    when you're not them)
  - `/<username>/<slug>` — that user's custom list, that user's overlay
- **Reserved slugs.** `RESERVED_SLUGS` blocks both username + list-slug
  inputs from claiming `list`, `admin`, `api`, `about`, `privacy`,
  `signin`, `signout`, `signup`, `login`, `logout`, `_next`, `assets`,
  `static`, `public`, `favicon.ico`, `robots.txt`, `sitemap.xml`.
- **Back-compat.** Old `?u=<uuid>` (and `?u=<uuid>&list=<slug>`) links
  resolve to `/<username>` or `/<username>/<slug>` via `history.replaceState`
  when the user has picked a username. Users with no profile fall back to
  the legacy `public_lists` overlay path.
- **Hamburger menu.** Replaces the old email pill + share button. Contains:
  username editor (with debounced availability + reserved-slug check),
  share panel (raw list vs. progress overlay), All lists, New list, owner
  Edit/Delete (Delete hidden + DB-blocked for the default list), Sign out.
  On mobile (≤720px) the menu opens as a slide-up bottom sheet.
- **New list / Edit list modal.** Paste CSV or JSON, header alias map
  (`Restaurant`/`Title` → `name`, `Website`/`Link` → `url`, etc.), 100-item
  hard cap, 20-list-per-account cap, optional Nominatim geocoding (1 req/s,
  results cached in `geocode_cache`), inline retry for failed addresses,
  skip-and-save allowed (rows without coords don't render on the map).
  Edit uses a `replace_list_items` RPC for atomic swaps.
- **All lists directory.** Modal listing up to 200 active lists with their
  owner (username), item count, and the viewer's progress when signed in.

### Known limitations

- **OG tags.** `index.html` carries fixed `og:title`/`og:description`/
  `og:url` for the home page. Server-side rendering or a static-export step
  would be needed to give per-list URLs custom previews. Not in scope.
- **Moderation.** No abuse tooling for usernames or list content. The
  reserved-slug list keeps system-y names away from users; everything else
  is first-come-first-served. If we need takedowns, do them via the SQL
  console for now.
- **Anonymous custom-list progress.** `localStorage` only caches progress
  on the default list. Custom lists require sign-in to track progress, by
  design — scoping localStorage per slug would silently lose data when a
  list is renamed or deleted.
- **`public_lists` table.** Kept around so legacy `?u=<uuid>` share links
  still resolve when the target user hasn't picked a username. Deprecation
  is a follow-up migration.

### Default-list deletion policy

The seeded default list (`slug = 'chronicle-top-100-2026'`) cannot be
deleted from any UI surface, and a Postgres trigger
(`prevent_default_list_delete`) raises if anything tries to delete it
through the database directly. Soft-delete via `deleted_at` is also blocked
at the application layer (the Delete row is hidden in the menu for that
slug).

## Migration order — DO NOT REORDER

```
1. Apply 001_usernames_lists.sql        (additive: new tables + nullable list_id)
2. Have kidhack@kidhack.com sign in     (creates auth.users row for the seed)
3. Apply 002_seed_default_list.sql      (seeds the SF Chronicle list)
4. Deploy frontend                      (uploads to Dreamhost via SFTP/rsync)
5. Apply 003_backfill_list_id.sql       (fills nulls, NOT NULL, tightens RLS)
```

Reversing 4 and 5 risks duplicate `(user_id, null, rank)` and
`(user_id, default_list_id, rank)` rows that fail the post-backfill unique
constraint. The 003 migration includes a defensive dedupe step that
deletes the null-list_id row in that case, so the migration still
succeeds, but the user's most-recent toggle wins (whichever the new
frontend wrote with `list_id`).

## Deploy target — Dreamhost shared hosting

This site is deployed to Dreamhost shared hosting (Apache + `mod_rewrite`).
There is no build step; the deploy is a plain SFTP/rsync of the static
files into the document root. The repo's `npm run dist` script just
duplicates the files into `dist/` for a local sanity check.

Files to upload (preserve directory structure):

```
index.html
styles.css
app.js
data/restaurants.js
.htaccess
```

`.htaccess` is required:

- Forces HTTPS so Supabase magic-link redirects always land on the canonical
  origin.
- Serves real files/directories as-is (so `/styles.css`, `/app.js`,
  `/data/restaurants.js`, etc. are not rewritten).
- Falls back to `/index.html` for any other path so the client-side router
  can take over (`/<username>`, `/list/<slug>`, `/<username>/<slug>`).

Dreamhost honours `.htaccess` out of the box; no panel toggles required.

## Local testing

```
node --check app.js                # quick syntax sanity
npm run dist                       # builds dist/ for local preview
node scripts/generate-default-list-sql.mjs  # regenerate seed after editing data/restaurants.js
```

To preview locally with the SPA fallback you can run a tiny static server,
but most flows work fine with `python3 -m http.server` from the repo root
(SPA fallback only matters when you reload on a non-`/` URL; the app
itself handles `popstate` and link clicks via `history.pushState`).
