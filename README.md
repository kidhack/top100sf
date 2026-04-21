```
╶┬╴╭─╮╭─╮  ╶╮ ╭─╮╭─╮   ╭─╮╭─╴
 │ │ │├─╯   │ ││││││   ╰─╮├╴
 ╵ ╰─╯╵     ┴╴╰─╯╰─╯   ╰─╯╵
```

What started as a simple app to track 2026 SF Chronicle's Top 100 Bay Area restaurants, now you can create your own lists of places to visit and favorite.

## [Top100SF.com](https://top100sf.com)

---

Inspired by [elizabethsiegle/sfchronicle-top-100-restaurants2026](https://github.com/elizabethsiegle/sfchronicle-top-100-restaurants2026).

### Built with

- **Plain HTML + CSS + vanilla JS** — static `index.html` / `app.js` deploy (no React/Vite client bundle)
- **[Leaflet](https://leafletjs.com/)** — map tiles, markers, and popups
- **[Supabase](https://supabase.com/)** — Auth, Postgres (`lists`, `list_items`, `visited`, `hearted`), Row Level Security, and RPCs for shared progress
- **Google Places API** — Text Search when adding venues in the create / edit list modal (key injected at build time or via `config.local.js` / env for local dev)
