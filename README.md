```
╶┬╴╭─╮╭─╮  ╶╮ ╭─╮╭─╮   ╭─╮╭─╴
 │ │ │├─╯   │ ││││││   ╰─╮├╴
 ╵ ╰─╯╵     ┴╴╰─╯╰─╯   ╰─╯╵
```

What started as an app to track [2026 SF Chronicle's Top 100 Bay Area restaurants](https://www.sfchronicle.com/projects/2026/top-100-best-restaurants-san-francisco-bay-area/) now allows you to create your own lists, track visits & favorites, and share your status.

## 🍽️ → [Top100SF.com](https://top100sf.com)

Lists can created by adding places individually via search or in bulk by pasting formatted JSON or CSV.

JSON format:
```
  [{
    "rank": 1,
    "name": "Rich Table",
    "address": "199 Gough St.",
    "city": "San Francisco",
    "cuisine": "American",
    "url": "https://www.richtablesf.com/"
    "lat": 37.77485,
    "lng": -122.422843,
  },
  {
    "rank": 2,
    "name": "Zuni Café",
    "address": "1658 Market St.",
    "city": "San Francisco",
    "cuisine": "Californian",
    "url": "http://zunicafe.com"
    "lat": 37.7736,
    "lng": -122.421608,
   }]
```

---

Inspired by [elizabethsiegle/sfchronicle-top-100-restaurants2026](https://github.com/elizabethsiegle/sfchronicle-top-100-restaurants2026).

### Built with

- **Plain HTML + CSS + vanilla JS** — static `index.html` / `app.js` deploy
- **[Leaflet](https://leafletjs.com/)** — map tiles, markers, and popups
- **[Supabase](https://supabase.com/)** — Auth, Postgres, Row Level Security, and RPCs
- **Google Places API** — For adding venues
