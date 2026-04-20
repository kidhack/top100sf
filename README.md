# top100

Simple app to track visited 2026 SF Chronicle's Top 100 Bay Area restaurants.

Inspired by [elizabethsiegle/sfchronicle-top-100-restaurants2026](https://github.com/elizabethsiegle/sfchronicle-top-100-restaurants2026).

## What it does

- Browse the full list as a sortable table or as pins on a Leaflet map.
- Tap a row (or pin) to mark a restaurant as visited or favorite it.
- Optionally sign in with Supabase to sync visits/favorites across devices and share a read-only view of your list with a link.

## Run it locally

It's a single static file — no build step required.

```bash
npx serve .
# then open http://localhost:3000
```

To package a self-contained `dist/` folder (and zip):

```bash
npm run dist   # writes dist/
npm run pack   # writes top100-dist.zip
```

## Optional: Supabase sync & sharing

Sync and sharing only turn on if you wire up a Supabase project. Set the URL and anon key at the top of `index.html`, then run [`supabase/schema.sql`](supabase/schema.sql) once in the Supabase SQL editor to create the `visited`, `hearted`, and `public_lists` tables (with the right row-level security policies).

## Data

`restaurants.json` is the 2026 SF Chronicle Top 100 list with names, neighborhoods, and lat/lng. `websites.txt` keeps the source URLs alongside it.

## Built with

- Plain HTML + vanilla JS, no framework
- [Leaflet](https://leafletjs.com/) for the map
- [Supabase](https://supabase.com/) (optional) for auth, sync, and sharing
