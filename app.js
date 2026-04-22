import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Papa from 'https://esm.sh/papaparse@5';
import { RESTAURANTS as DEFAULT_RESTAURANTS } from './data/restaurants.js';

if (typeof navigator !== 'undefined' && navigator.vendor?.includes('Apple')) {
  document.documentElement.classList.add('is-safari');
}

const SUPABASE_URL = 'https://goeehdtfgzscyaazbewb.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EgEDBzERdk7DQK5fXk9fjQ_o_viqH0e';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function getGooglePlacesApiKey() {
  const m = typeof document !== 'undefined' && document.querySelector('meta[name="google-places-api-key"]');
  const fromMeta = (m?.getAttribute('content') || '').trim();
  if (fromMeta) return fromMeta;
  const fromGlobal = typeof globalThis !== 'undefined' && globalThis.__TOP100_GOOGLE_PLACES_KEY__;
  return String(fromGlobal || '').trim();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const DEFAULT_LIST_SLUG = 'chronicle-top-100-2026';
export const DEFAULT_LIST_NAME = 'SF Chronicle Top 100 - 2026';
export const DEFAULT_LIST_OWNER_USERNAME = 'kidhack';
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

/** DB seeds/migrations may predate renames; keep menus and edit UI on DEFAULT_LIST_NAME. */
function withCanonicalDefaultListName(list) {
  if (!list || list.slug !== DEFAULT_LIST_SLUG) return list;
  if (list.name === DEFAULT_LIST_NAME) return list;
  return { ...list, name: DEFAULT_LIST_NAME };
}

// Reserved at the path level: blocks both /<username> and /list/<slug>
// from grabbing names we may want for marketing or system pages later.
export const RESERVED_SLUGS = new Set([
  'list', 'admin', 'api', 'about', 'privacy', 'signin', 'signout',
  'signup', 'login', 'logout', '_next', 'assets', 'static', 'public',
  'favicon.ico', 'robots.txt', 'sitemap.xml',
]);

const STORAGE_KEY_VISITED = 'sf100_visited_v2';
const STORAGE_KEY_HEARTED = 'sf100_hearted_v2';
const LEGACY_STORAGE_VISITED = 'sf100_visited_v1';
const LEGACY_STORAGE_HEARTED = 'sf100_hearted_v1';

const USERNAME_RE = /^[a-zA-Z0-9]{2,32}$/;
const SLUG_RE = /^[a-zA-Z0-9-]{2,32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUsername(s) { return typeof s === 'string' && USERNAME_RE.test(s); }
export function isValidSlug(s) { return typeof s === 'string' && SLUG_RE.test(s); }

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------
export function parseRoute(pathname = window.location.pathname) {
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return { kind: 'default' };

  if (segments[0] === 'list') {
    if (segments.length === 2 && isValidSlug(segments[1]) && !RESERVED_SLUGS.has(segments[1])) {
      return { kind: 'list', slug: segments[1] };
    }
    return { kind: 'invalid', reason: 'malformed list path' };
  }

  if (segments.length > 2) return { kind: 'invalid', reason: 'too many path segments' };

  if (RESERVED_SLUGS.has(segments[0])) {
    return { kind: 'invalid', reason: `reserved path: ${segments[0]}` };
  }
  if (!isValidUsername(segments[0])) {
    return { kind: 'invalid', reason: 'invalid username' };
  }

  if (segments.length === 1) {
    return { kind: 'user', username: segments[0] };
  }

  if (!isValidSlug(segments[1]) || RESERVED_SLUGS.has(segments[1])) {
    return { kind: 'invalid', reason: 'invalid list slug' };
  }
  return { kind: 'user-list', username: segments[0], slug: segments[1] };
}

// ---------------------------------------------------------------------------
// Mutable runtime state. `restaurants`, `rowEls`, and `markers` are rebuilt
// every time the loaded list changes.
// ---------------------------------------------------------------------------
let restaurants = [];
let listMeta = null;             // { id, slug, name, owner_id, owner_username, isDefault, deleted_at }
let route = parseRoute();
// visited/hearted hold progress keys for the overlay user, scoped
// globally across lists. Membership on the current list is derived by
// intersecting against `restaurants`.
const visited = new Set();
const hearted = new Set();
let rowEls = {};
let markers = {};
/** @type {L.Marker | null} — “you are here” after a successful Locate me. */
let userLocationMarker = null;
/** Clears the blue dot if the user hasn’t tapped Locate me again within this window. */
const USER_LOCATION_AUTO_HIDE_MS = 5 * 60 * 1000;
let userLocationHideTimer = null;

function clearUserLocationAutoHideTimer() {
  if (userLocationHideTimer !== null) {
    clearTimeout(userLocationHideTimer);
    userLocationHideTimer = null;
  }
}

function removeUserLocationMarkerFromMap(mapInstance) {
  clearUserLocationAutoHideTimer();
  if (userLocationMarker) {
    if (mapInstance.hasLayer(userLocationMarker)) {
      mapInstance.removeLayer(userLocationMarker);
    }
    userLocationMarker = null;
  }
}

function scheduleUserLocationAutoHide(mapInstance) {
  clearUserLocationAutoHideTimer();
  userLocationHideTimer = setTimeout(() => {
    userLocationHideTimer = null;
    removeUserLocationMarkerFromMap(mapInstance);
  }, USER_LOCATION_AUTO_HIDE_MS);
}
let current = null;
// Monotonic token bumped on every applyRoute() call so background tasks
// (e.g. geocode backfill) can detect stale state and bail out cleanly when
// the user navigates away mid-flight.
let routeToken = 0;

let currentUser = null;
let currentProfile = null;        // { user_id, username }
let viewingUserId = null;         // overlay user id (null = signed-in user's own progress)
let viewingProfile = null;        // { user_id, username } for the overlay
let sharingEnabled = false;

const tbody = document.getElementById('rows');
const info = document.getElementById('info');
const authEl = document.getElementById('auth');
const viewBanner = document.getElementById('view-banner');
const listBody = document.querySelector('.list-body');

// Auto-hide the list scrollbar when the user isn't actively scrolling.
if (listBody) {
  let scrollTimer;
  listBody.addEventListener('scroll', () => {
    listBody.classList.add('is-scrolling');
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => listBody.classList.remove('is-scrolling'), 800);
  }, { passive: true });
}

const map = L.map('map', {
  zoomControl: false,
  attributionControl: true,
}).setView([37.78, -122.42], 11);

const zoomControl = L.control.zoom({ position: 'bottomright' });

/** Apple CoreSVG “location” asset (user-provided location.svg), inlined for the map control. */
const locateMeSvg =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20.2703 18.4783" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M0.833401 7.47647C-0.514255 8.10147-0.143161 9.90811 1.34121 9.91787L8.46035 9.94717C8.57754 9.94717 8.60684 9.97647 8.60684 10.0937L8.62637 17.1542C8.63614 18.6972 10.4721 18.9706 11.1264 17.5546L18.3432 2.03701C19.0072 0.591702 17.8744-0.433689 16.4389 0.240139ZM2.53262 8.39444C2.49356 8.39444 2.48379 8.35537 2.53262 8.33584L16.5658 1.91006C16.6342 1.88076 16.6635 1.9003 16.6342 1.97842L10.1693 16.0019C10.1596 16.0409 10.1205 16.0312 10.1205 15.9921L10.1693 9.0878C10.1693 8.65811 9.8666 8.35537 9.42715 8.35537Z"/></svg>';

function updateUserLocationMarker(mapInstance, lat, lng) {
  const latLng = L.latLng(lat, lng);
  if (userLocationMarker) {
    userLocationMarker.setLatLng(latLng);
    userLocationMarker.bringToFront();
    return;
  }
  const icon = L.divIcon({
    className: 'user-location-marker',
    html: '<div class="user-location-dot" aria-hidden="true"></div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
  userLocationMarker = L.marker(latLng, {
    icon,
    interactive: false,
    keyboard: false,
    zIndexOffset: 1000,
  }).addTo(mapInstance);
}

function locateUserOnMap(mapInstance) {
  if (!navigator.geolocation) {
    console.warn('Geolocation is not supported in this browser.');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      updateUserLocationMarker(mapInstance, lat, lng);
      mapInstance.flyTo([lat, lng], Math.max(mapInstance.getZoom(), 14), { duration: 0.6 });
      scheduleUserLocationAutoHide(mapInstance);
    },
    (err) => {
      console.warn('Could not get location', err.message || err.code);
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
  );
}

const LocateMeControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd(mapInstance) {
    const wrapper = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-locate-wrap');
    const btn = L.DomUtil.create('button', 'leaflet-control-locate-me', wrapper);
    btn.type = 'button';
    btn.title = 'Locate me';
    btn.setAttribute('aria-label', 'Locate me');
    btn.innerHTML = locateMeSvg;
    L.DomEvent.disableClickPropagation(wrapper);
    L.DomEvent.on(btn, 'click', (e) => {
      L.DomEvent.stopPropagation(e);
      L.DomEvent.preventDefault(e);
      locateUserOnMap(mapInstance);
    });
    return wrapper;
  },
});
const locateMeControl = new LocateMeControl();

function syncMapMobileControls() {
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  if (mobile) {
    if (zoomControl._map) map.removeControl(zoomControl);
    if (!locateMeControl._map) locateMeControl.addTo(map);
  } else {
    if (locateMeControl._map) map.removeControl(locateMeControl);
    if (!zoomControl._map) zoomControl.addTo(map);
  }
}
syncMapMobileControls();
window.matchMedia('(max-width: 720px)').addEventListener('change', syncMapMobileControls);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  maxZoom: 19,
  subdomains: 'abcd',
}).addTo(map);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const linkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.07 0l3.54-3.54a5 5 0 0 0-7.07-7.07L11.5 4.5"/><path d="M14 11a5 5 0 0 0-7.07 0L3.4 14.54a5 5 0 0 0 7.07 7.07L12.5 19.5"/></svg>';
const heartIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path fill="none" d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
const checkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function mapsUrl(r) {
  const isApple = /iPhone|iPad|iPod|Macintosh/i.test(navigator.userAgent);
  const q = encodeURIComponent(`${r.name}, ${r.address ?? ''}, ${r.city ?? ''}`);
  if (isApple && r.lat != null && r.lng != null) {
    return `https://maps.apple.com/?q=${q}&ll=${r.lat},${r.lng}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

function isReadOnly() {
  return !!viewingUserId && (!currentUser || currentUser.id !== viewingUserId);
}

function isDefaultList() {
  return !!listMeta && listMeta.slug === DEFAULT_LIST_SLUG;
}

// Whether to write per-anonymous-user state to localStorage for the current
// session. Tie this to the **home route** (`/`, parseRoute kind `default`),
// not to `listMeta.slug === DEFAULT_LIST_SLUG`. After Supabase loads, the
// canonical slug in the DB may differ from DEFAULT_LIST_SLUG (e.g. NYC
// deploy); if we keyed only on slug, `loadOverlay` would call
// `clearLocalState()` on every reload and wipe visited/hearts for signed-out
// users. Custom lists (`/list/...`) still require sign-in — no localStorage.
function shouldUseLocalStorage() {
  return !viewingUserId && route.kind === 'default';
}

// ---------------------------------------------------------------------------
// Name-key helpers. Postgres `visited.name_key` is `lower(btrim(name))`
// (migration 004). Keys in memory MUST match that for list rows to light up
// after `loadOverlay`. We also merge keys from the stored `name` column when
// fetching so toggles and DB rows stay aligned even if JS `toLowerCase` and
// PG `lower` ever diverge on an edge character.
// ---------------------------------------------------------------------------
/** Mirrors Postgres `lower(btrim(name))` closely for list-item display names. */
function progressKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

/**
 * Loose match key so the same venue lines up across lists when punctuation,
 * Unicode quotes, or spacing differ slightly between `visited.name` (from one
 * list) and `list_items.name` (from another). Postgres `name_key` stays strict;
 * this is an extra client-side bucket only in the in-memory sets.
 */
function collapseMatchKey(s) {
  try {
    return String(s ?? '')
      .normalize('NFKC')
      .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035\u0060\u00B4]/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  } catch {
    return progressKey(s);
  }
}

/** Keys loaded from `visited` / `hearted` rows (name + generated name_key). */
function keysFromProgressRows(rows) {
  const keys = new Set();
  for (const row of rows || []) {
    if (row.name_key != null && String(row.name_key).trim() !== '') {
      const nk = String(row.name_key).trim();
      keys.add(nk);
      const ckn = collapseMatchKey(nk);
      if (ckn) keys.add(ckn);
    }
    if (row.name != null && String(row.name).trim() !== '') {
      keys.add(progressKey(row.name));
      const cm = collapseMatchKey(row.name);
      if (cm) keys.add(cm);
    }
  }
  return keys;
}

// PostgREST/Postgres errors when the deployed DB is still on the pre-004
// schema (visited/hearted keyed by list_id+rank, no name/name_key).
function isMissingProgressColumnError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === '42703' || code === 'PGRST204') return true;
  const msg = String(err.message || err).toLowerCase();
  if (msg.includes('name_key') && (msg.includes('does not exist') || msg.includes('could not find'))) return true;
  if (msg.includes('column') && msg.includes('name') && msg.includes('visited') && msg.includes('could not find')) return true;
  if (msg.includes('column') && msg.includes('name') && msg.includes('hearted') && msg.includes('could not find')) return true;
  return false;
}

/** PostgREST / Postgres when `list_items` select references a missing column. */
function isMissingListItemsColumnError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === '42703' || code === 'PGRST204') return true;
  const msg = String(err.message || err).toLowerCase();
  if (msg.includes('schema cache') && msg.includes('could not find')) return true;
  if (msg.includes('column') && msg.includes('does not exist')) return true;
  return false;
}

function isRlsWriteDeniedError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === '42501') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('row-level security') || msg.includes('permission denied') || msg.includes('rls');
}

function warnVisitedSyncBlocked(err, context) {
  console.error(context, err);
  if (!isRlsWriteDeniedError(err)) return;
  const onceKey = 'top100_warned_rls_visited';
  if (sessionStorage.getItem(onceKey)) return;
  sessionStorage.setItem(onceKey, '1');
  alert(
    'Could not save visited/hearts to your account (the database blocked the write). '
    + 'If you host Supabase yourself, run migration 006_visited_hearted_write_rls.sql from the project repo.',
  );
}

/** Map legacy visited/hearted rows to normalized name keys for the current list. */
function nameKeysFromLegacyRankRows(rows, listId, restaurantsForList) {
  const keys = new Set();
  for (const row of rows || []) {
    const lid = row.list_id;
    if (listId && lid != null && lid !== listId) continue;
    if (listId && lid == null) continue;
    const r = restaurantsForList.find(x => x.rank === row.rank);
    if (r) keys.add(progressKey(r.name));
  }
  return keys;
}

/** Load progress rows by `name` (global across lists). Tries `name_key` when present. */
async function fetchProgressRowsByName(table, userId) {
  let res = await supabase.from(table).select('name, name_key').eq('user_id', userId);
  if (!res.error) return res;
  if (!isMissingProgressColumnError(res.error)) return res;
  return supabase.from(table).select('name').eq('user_id', userId);
}

async function fetchOverlayProgressSet(table, userId, listId, restaurantsForList) {
  const res = await fetchProgressRowsByName(table, userId);
  if (!res.error) {
    return {
      keys: keysFromProgressRows(res.data),
      usedLegacy: false,
      error: null,
    };
  }
  if (!isMissingProgressColumnError(res.error)) {
    return { keys: null, usedLegacy: false, error: res.error };
  }
  const leg = await supabase.from(table).select('list_id,rank').eq('user_id', userId);
  if (leg.error) return { keys: null, usedLegacy: true, error: leg.error };
  return {
    keys: nameKeysFromLegacyRankRows(leg.data, listId, restaurantsForList),
    usedLegacy: true,
    error: null,
  };
}

/**
 * In-memory visited/hearted sets store several string variants per restaurant
 * (see addKeyVariants). Batch upserts must send at most one row per
 * (user_id, name_key) or Postgres errors: "ON CONFLICT DO UPDATE command cannot
 * affect row a second time".
 */
function dedupeProgressNameRows(userId, keys, nameForKeyFn) {
  const seen = new Set();
  const rows = [];
  for (const k of keys) {
    const name = nameForKeyFn(k);
    const nk = progressKey(name);
    if (!nk) continue;
    if (seen.has(nk)) continue;
    seen.add(nk);
    rows.push({ user_id: userId, name });
  }
  return rows;
}

function nameKeyForRank(rank) {
  const r = restaurants.find(x => x.rank === rank);
  return r ? progressKey(r.name) : null;
}

function isVisitedRank(rank) {
  const r = restaurants.find(x => x.rank === rank);
  return !!r && progressSetHas(visited, r.name, r.name_key);
}

function isHeartedRank(rank) {
  const r = restaurants.find(x => x.rank === rank);
  return !!r && progressSetHas(hearted, r.name, r.name_key);
}

function visitedCountOnList() {
  let n = 0;
  for (const r of restaurants) if (progressSetHas(visited, r.name, r.name_key)) n++;
  return n;
}

function heartedCountOnList() {
  let n = 0;
  for (const r of restaurants) if (progressSetHas(hearted, r.name, r.name_key)) n++;
  return n;
}

function keysFromStoragePayload(raw) {
  if (raw == null || raw === '') return new Set();
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr) || arr.length === 0) return new Set();
  if (typeof arr[0] === 'number') {
    const out = new Set();
    for (const rank of arr) {
      const r = DEFAULT_RESTAURANTS.find(x => x.rank === rank);
      if (r) out.add(progressKey(r.name));
    }
    return out;
  }
  const out = new Set();
  for (const x of arr) {
    if (typeof x === 'string' && x) out.add(progressKey(x));
  }
  return out;
}

// Read a Set of name slugs from localStorage. Handles legacy rank-based payloads
// (array of ints) by mapping ranks through DEFAULT_RESTAURANTS names; that
// path is only taken for the default list, which is the only place we ever
// used localStorage. If the v2 key is absent, migrates v1 → v2 (slug keys).
function readStoredNameKeys(key) {
  const legacyKey =
    key === STORAGE_KEY_VISITED ? LEGACY_STORAGE_VISITED
    : key === STORAGE_KEY_HEARTED ? LEGACY_STORAGE_HEARTED
    : null;
  try {
    const pRaw = localStorage.getItem(key);
    if (pRaw !== null) return keysFromStoragePayload(pRaw);
    if (!legacyKey) return new Set();
    const out = keysFromStoragePayload(localStorage.getItem(legacyKey));
    if (out.size) {
      localStorage.setItem(key, JSON.stringify([...out]));
      localStorage.removeItem(legacyKey);
    }
    return out;
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------
// Render: rows + markers. Called from setRestaurants() when the list
// content changes (initial paint or post-fetch diff).
// ---------------------------------------------------------------------------
function renderRows() {
  tbody.innerHTML = '';
  rowEls = {};
  for (const r of restaurants) {
    const tr = document.createElement('tr');
    tr.dataset.rank = r.rank;
    if (isVisitedRank(r.rank)) tr.classList.add('visited');
    if (isHeartedRank(r.rank)) tr.classList.add('hearted');
    tr.innerHTML = `
      <td class="col-rank">${r.rank}</td>
      <td>
        <div class="col-name"></div>
      </td>
      <td class="col-action">
        ${r.url
          ? `<a class="icon-btn" href="${escapeHtml(r.url)}" target="_blank" rel="noopener" title="Open listing" aria-label="Open listing">${linkIcon}</a>`
          : ''}
      </td>
      <td class="col-action">
        <button type="button" class="icon-btn check" title="Mark visited" aria-label="Mark visited">${checkIcon}</button>
      </td>
      <td class="col-action">
        <button type="button" class="icon-btn heart" title="Heart" aria-label="Heart restaurant" aria-pressed="${isHeartedRank(r.rank)}">${heartIcon}</button>
      </td>
    `;
    tr.querySelector('.col-name').textContent = r.name;

    const link = tr.querySelector('a.icon-btn');
    if (link) link.addEventListener('click', e => e.stopPropagation());

    const heartBtn = tr.querySelector('button.heart');
    heartBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleHeart(r.rank);
    });

    const checkBtn = tr.querySelector('button.check');
    checkBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleVisited(r.rank);
    });

    tr.addEventListener('click', () => select(r.rank, { scrollList: false }));
    tbody.appendChild(tr);
    rowEls[r.rank] = tr;
  }
}

function addMarkerForRow(r) {
  if (r.lat == null || r.lng == null) return;
  if (markers[r.rank]) {
    map.removeLayer(markers[r.rank]);
    delete markers[r.rank];
  }
  const icon = L.divIcon({
    className: '',
    html: `<div class="pin${isVisitedRank(r.rank) ? ' visited' : ''}${isHeartedRank(r.rank) ? ' hearted' : ''}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
  const m = L.marker([r.lat, r.lng], { icon, title: `${r.rank}. ${r.name}` }).addTo(map);
  m.on('click', () => select(r.rank, { scrollList: true }));
  markers[r.rank] = m;
}

function renderMarkers() {
  for (const m of Object.values(markers)) map.removeLayer(m);
  markers = {};
  for (const r of restaurants) addMarkerForRow(r);
}

function pinEl(rank) {
  const m = markers[rank];
  return m ? (m.getElement() && m.getElement().querySelector('.pin')) : null;
}

/** Scroll only `.list-body` so the row sits near the top (map pin selection). */
function scrollListRowIntoView(tr, padding = 4) {
  if (!listBody || !tr) return;
  const rowTop = tr.getBoundingClientRect().top;
  const lbTop = listBody.getBoundingClientRect().top;
  const nextTop = Math.max(0, listBody.scrollTop + (rowTop - lbTop) - padding);
  listBody.scrollTo({ top: nextTop, behavior: 'smooth' });
}

/** @param {{ scrollList?: boolean }} [opts] — scrollList: scroll list pane (e.g. after map pin tap). */
function select(rank, opts = {}) {
  const { scrollList = false } = opts;
  const r = restaurants.find(x => x.rank === rank);
  if (!r) return;
  if (current !== null) {
    if (rowEls[current]) rowEls[current].classList.remove('selected');
    const prevPin = pinEl(current);
    if (prevPin) prevPin.classList.remove('selected');
  }
  current = rank;
  const row = rowEls[rank];
  if (row) {
    row.classList.add('selected');
    if (scrollList) scrollListRowIntoView(row);
  }
  const pin = pinEl(rank);
  if (pin) pin.classList.add('selected');
  if (r.lat != null && r.lng != null) {
    map.flyTo([r.lat, r.lng], Math.max(map.getZoom(), 14), { duration: 0.6 });
  }
  info.innerHTML = `
    <div class="name">#${r.rank} · ${escapeHtml(r.name)}</div>
    <div class="sub">${escapeHtml(r.cuisine)}</div>
    <div class="sub"><a href="${escapeHtml(mapsUrl(r))}" target="_blank" rel="noopener">${escapeHtml(r.address || '')}${r.city ? ', ' : ''}<span class="city">${escapeHtml(r.city)}</span></a></div>
  `;
}

// ---------------------------------------------------------------------------
// State application: apply visited/hearted sets (of name slugs) to existing
// rows + markers without rebuilding them.
// ---------------------------------------------------------------------------
function saveVisited() {
  if (shouldUseLocalStorage()) {
    localStorage.setItem(STORAGE_KEY_VISITED, JSON.stringify([...visited]));
  }
  const vc = document.getElementById('visited-count');
  if (vc) {
    const n = visitedCountOnList();
    vc.textContent = n ? String(n) : '';
  }
}

function saveHearted() {
  if (shouldUseLocalStorage()) {
    localStorage.setItem(STORAGE_KEY_HEARTED, JSON.stringify([...hearted]));
  }
  const hc = document.getElementById('hearted-count');
  if (hc) {
    const n = heartedCountOnList();
    hc.textContent = n ? String(n) : '';
  }
}

// Replace the in-memory visited set (of name keys) and repaint every row +
// marker on the current list.
function addKeyVariants(set, k) {
  const s = String(k ?? '').trim();
  if (!s) return;
  set.add(s);
  set.add(progressKey(s));
  const ck = collapseMatchKey(s);
  if (ck) set.add(ck);
}

function removeKeyVariants(set, displayName, rowNameKey) {
  const nk = rowNameKey != null && String(rowNameKey).trim() !== '' ? String(rowNameKey).trim() : '';
  if (nk) {
    set.delete(nk);
    set.delete(progressKey(nk));
    const ckn = collapseMatchKey(nk);
    if (ckn) set.delete(ckn);
  }
  const raw = String(displayName ?? '').trim();
  if (!raw) return;
  set.delete(raw);
  set.delete(progressKey(raw));
  const ckr = collapseMatchKey(raw);
  if (ckr) set.delete(ckr);
}

/**
 * True if `set` contains a key matching this list row.
 * Prefer `rowNameKey` when present (same formula as visited.name_key in Postgres).
 */
function progressSetHas(set, displayName, rowNameKey) {
  const nk = rowNameKey != null && String(rowNameKey).trim() !== '' ? String(rowNameKey).trim() : '';
  if (nk && set.has(nk)) return true;
  const pk = progressKey(displayName);
  if (set.has(pk)) return true;
  const raw = String(displayName ?? '').trim();
  if (raw !== '' && set.has(raw)) return true;
  if (nk) {
    const ckn = collapseMatchKey(nk);
    if (ckn && set.has(ckn)) return true;
  }
  const ck = collapseMatchKey(displayName);
  return !!(ck && set.has(ck));
}

function applyVisitedSet(next) {
  visited.clear();
  for (const k of next) addKeyVariants(visited, k);
  for (const r of restaurants) {
    const shouldBe = progressSetHas(visited, r.name, r.name_key);
    if (rowEls[r.rank]) rowEls[r.rank].classList.toggle('visited', shouldBe);
    if (markers[r.rank]) {
      const el = markers[r.rank].getElement();
      if (el) el.querySelector('.pin').classList.toggle('visited', shouldBe);
    }
  }
  saveVisited();
}

function applyHeartedSet(next) {
  hearted.clear();
  for (const k of next) addKeyVariants(hearted, k);
  for (const r of restaurants) {
    const shouldBe = progressSetHas(hearted, r.name, r.name_key);
    const row = rowEls[r.rank];
    if (row) {
      row.classList.toggle('hearted', shouldBe);
      const hb = row.querySelector('button.heart');
      if (hb) hb.setAttribute('aria-pressed', String(shouldBe));
    }
    if (markers[r.rank]) {
      const el = markers[r.rank].getElement();
      if (el) el.querySelector('.pin').classList.toggle('hearted', shouldBe);
    }
  }
  saveHearted();
}

function clearLocalState() {
  visited.clear();
  hearted.clear();
  for (const r of restaurants) {
    if (rowEls[r.rank]) rowEls[r.rank].classList.remove('visited', 'hearted');
    if (markers[r.rank]) {
      const el = markers[r.rank].getElement();
      if (el) el.querySelector('.pin').classList.remove('visited', 'hearted');
    }
  }
  saveVisited();
  saveHearted();
}

// ---------------------------------------------------------------------------
// Toggle handlers. Writes are keyed on restaurant identity (`progressKey` +
// stored `name` / legacy rank) so the same place stays in sync across lists.
// ---------------------------------------------------------------------------
async function toggleHeart(rank) {
  if (isReadOnly()) return;
  const r = restaurants.find(x => x.rank === rank);
  if (!r) return;
  const nowHearted = !progressSetHas(hearted, r.name, r.name_key);
  if (nowHearted) addKeyVariants(hearted, r.name);
  else removeKeyVariants(hearted, r.name, r.name_key);
  const row = rowEls[rank];
  if (row) {
    row.classList.toggle('hearted', nowHearted);
    const hb = row.querySelector('button.heart');
    if (hb) hb.setAttribute('aria-pressed', String(nowHearted));
  }
  if (markers[rank]) {
    const el = markers[rank].getElement();
    if (el) el.querySelector('.pin').classList.toggle('hearted', nowHearted);
  }
  saveHearted();

  if (!currentUser) return;
  try {
    if (nowHearted) {
      let { error } = await supabase
        .from('hearted')
        .upsert({ user_id: currentUser.id, name: r.name }, { onConflict: 'user_id,name_key' });
      if (error && isMissingProgressColumnError(error) && listMeta?.id) {
        ({ error } = await supabase
          .from('hearted')
          .upsert(
            { user_id: currentUser.id, list_id: listMeta.id, rank: r.rank },
            { onConflict: 'user_id,list_id,rank' },
          ));
      }
      if (error) throw error;
    } else {
      let { error } = await supabase
        .from('hearted')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('name', r.name);
      if (error && isMissingProgressColumnError(error) && listMeta?.id) {
        ({ error } = await supabase
          .from('hearted')
          .delete()
          .match({ user_id: currentUser.id, list_id: listMeta.id, rank: r.rank }));
      }
      if (error) throw error;
    }
  } catch (e) {
    warnVisitedSyncBlocked(e, 'heart sync failed for ' + r.name);
    if (nowHearted) {
      removeKeyVariants(hearted, r.name, r.name_key);
      if (rowEls[rank]) {
        rowEls[rank].classList.remove('hearted');
        const hb = rowEls[rank].querySelector('button.heart');
        if (hb) hb.setAttribute('aria-pressed', 'false');
      }
      if (markers[rank]) {
        const el = markers[rank].getElement();
        if (el) el.querySelector('.pin').classList.remove('hearted');
      }
      saveHearted();
    } else {
      addKeyVariants(hearted, r.name);
      if (rowEls[rank]) {
        rowEls[rank].classList.add('hearted');
        const hb = rowEls[rank].querySelector('button.heart');
        if (hb) hb.setAttribute('aria-pressed', 'true');
      }
      if (markers[rank]) {
        const el = markers[rank].getElement();
        if (el) el.querySelector('.pin').classList.add('hearted');
      }
      saveHearted();
    }
  }
}

async function toggleVisited(rank) {
  if (isReadOnly()) return;
  const r = restaurants.find(x => x.rank === rank);
  if (!r) return;
  const nowVisited = !progressSetHas(visited, r.name, r.name_key);
  if (nowVisited) addKeyVariants(visited, r.name);
  else removeKeyVariants(visited, r.name, r.name_key);
  if (rowEls[rank]) rowEls[rank].classList.toggle('visited', nowVisited);
  if (markers[rank]) {
    const el = markers[rank].getElement();
    if (el) el.querySelector('.pin').classList.toggle('visited', nowVisited);
  }
  saveVisited();

  // Unvisiting also clears the heart for the same restaurant.
  if (!nowVisited && progressSetHas(hearted, r.name, r.name_key)) {
    removeKeyVariants(hearted, r.name, r.name_key);
    if (rowEls[rank]) {
      rowEls[rank].classList.remove('hearted');
      const hb = rowEls[rank].querySelector('button.heart');
      if (hb) hb.setAttribute('aria-pressed', 'false');
    }
    if (markers[rank]) {
      const el = markers[rank].getElement();
      if (el) el.querySelector('.pin').classList.remove('hearted');
    }
    saveHearted();
    if (currentUser) {
      try {
        let { error } = await supabase
          .from('hearted')
          .delete()
          .eq('user_id', currentUser.id)
          .eq('name', r.name);
        if (error && isMissingProgressColumnError(error) && listMeta?.id) {
          ({ error } = await supabase
            .from('hearted')
            .delete()
            .match({ user_id: currentUser.id, list_id: listMeta.id, rank: r.rank }));
        }
        if (error) throw error;
      } catch (e) {
        warnVisitedSyncBlocked(e, 'heart clear on unvisit failed for ' + r.name);
      }
    }
  }

  if (!currentUser) return;
  try {
    if (nowVisited) {
      let { error } = await supabase
        .from('visited')
        .upsert({ user_id: currentUser.id, name: r.name }, { onConflict: 'user_id,name_key' });
      if (error && isMissingProgressColumnError(error) && listMeta?.id) {
        ({ error } = await supabase
          .from('visited')
          .upsert(
            { user_id: currentUser.id, list_id: listMeta.id, rank: r.rank },
            { onConflict: 'user_id,list_id,rank' },
          ));
      }
      if (error) throw error;
    } else {
      let { error } = await supabase
        .from('visited')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('name', r.name);
      if (error && isMissingProgressColumnError(error) && listMeta?.id) {
        ({ error } = await supabase
          .from('visited')
          .delete()
          .match({ user_id: currentUser.id, list_id: listMeta.id, rank: r.rank }));
      }
      if (error) throw error;
    }
  } catch (e) {
    warnVisitedSyncBlocked(e, 'visited sync failed for ' + r.name);
    // Optimistic UI ran before the DB round-trip. Without a rollback, the row
    // stays "visited" (heart button appears) even when `visited` never saved —
    // then hearts can persist while visits stay empty for shared URLs.
    if (nowVisited) {
      removeKeyVariants(visited, r.name, r.name_key);
      if (rowEls[rank]) rowEls[rank].classList.remove('visited');
      if (markers[rank]) {
        const el = markers[rank].getElement();
        if (el) el.querySelector('.pin').classList.remove('visited');
      }
      saveVisited();
    } else {
      addKeyVariants(visited, r.name);
      if (rowEls[rank]) rowEls[rank].classList.add('visited');
      if (markers[rank]) {
        const el = markers[rank].getElement();
        if (el) el.querySelector('.pin').classList.add('visited');
      }
      saveVisited();
    }
  }
}

// ---------------------------------------------------------------------------
// Loader. Returns { list, restaurants, overlayUserId, overlayProfile }.
// Throws on resolution failure (caller renders error state).
// ---------------------------------------------------------------------------
async function fetchListBySlug(slug) {
  const { data, error } = await supabase
    .from('lists')
    .select('id, slug, name, owner_id, deleted_at')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('List not found');
    err.code = 'list_not_found';
    err.slug = slug;
    throw err;
  }
  let owner_username = null;
  const ownerRes = await supabase
    .from('profiles')
    .select('username')
    .eq('user_id', data.owner_id)
    .maybeSingle();
  if (!ownerRes.error && ownerRes.data) owner_username = ownerRes.data.username;
  return withCanonicalDefaultListName({
    ...data,
    owner_username,
    isDefault: data.slug === DEFAULT_LIST_SLUG,
  });
}

async function fetchListItems(listId) {
  const selectTries = [
    'rank, name, address, city, cuisine, url, lat, lng, place_id, name_key',
    'rank, name, address, city, cuisine, url, lat, lng, place_id',
    'rank, name, address, city, cuisine, url, lat, lng',
  ];
  let lastErr = null;
  for (const cols of selectTries) {
    const { data, error } = await supabase
      .from('list_items')
      .select(cols)
      .eq('list_id', listId)
      .order('rank', { ascending: true });
    if (!error) return data || [];
    if (!isMissingListItemsColumnError(error)) throw error;
    lastErr = error;
  }
  throw lastErr || new Error('fetchListItems failed');
}

async function fetchProfileByUsername(username) {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, username')
    .eq('username', username)
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    const err = new Error('User not found');
    err.code = 'user_not_found';
    err.username = username;
    throw err;
  }
  return data;
}

async function loadList(routeContext) {
  if (routeContext.kind === 'default') {
    // Degrade gracefully: the hardcoded DEFAULT_RESTAURANTS seed is always
    // available, so even if Supabase is unreachable / migrations aren't
    // applied / the seed row is missing, `/` still renders the list. The
    // sentinel list.id = null lets loadOverlay + the toggle handlers skip
    // cloud sync until a real list row exists.
    let list;
    let items = [];
    try {
      list = await fetchListBySlug(DEFAULT_LIST_SLUG);
      items = await fetchListItems(list.id);
    } catch (err) {
      console.warn('default list not available in Supabase yet; using seed fallback', err?.message || err);
      list = {
        id: null,
        slug: DEFAULT_LIST_SLUG,
        name: DEFAULT_LIST_NAME,
        owner_id: null,
        owner_username: DEFAULT_LIST_OWNER_USERNAME,
        isDefault: true,
        deleted_at: null,
      };
    }
    return {
      list,
      restaurants: items.length ? items : DEFAULT_RESTAURANTS,
      overlayUserId: currentUser?.id || null,
      overlayProfile: currentProfile,
    };
  }
  if (routeContext.kind === 'list') {
    const list = await fetchListBySlug(routeContext.slug);
    const items = await fetchListItems(list.id);
    return {
      list,
      restaurants: items,
      overlayUserId: currentUser?.id || null,
      overlayProfile: currentProfile,
    };
  }
  if (routeContext.kind === 'user') {
    const profile = await fetchProfileByUsername(routeContext.username);
    const list = await fetchListBySlug(DEFAULT_LIST_SLUG);
    const items = await fetchListItems(list.id);
    return {
      list,
      restaurants: items.length ? items : DEFAULT_RESTAURANTS,
      overlayUserId: profile.user_id,
      overlayProfile: profile,
    };
  }
  if (routeContext.kind === 'user-list') {
    const profile = await fetchProfileByUsername(routeContext.username);
    const list = await fetchListBySlug(routeContext.slug);
    const items = await fetchListItems(list.id);
    return {
      list,
      restaurants: items,
      overlayUserId: profile.user_id,
      overlayProfile: profile,
    };
  }
  throw new Error('unsupported route: ' + JSON.stringify(routeContext));
}

// ---------------------------------------------------------------------------
// setRestaurants: swap out the rendered list, preserving overlay state when
// possible. Used by both the optimistic first paint and the post-fetch
// reconciliation.
// ---------------------------------------------------------------------------
function restaurantsEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.rank !== y.rank || x.name !== y.name || x.lat !== y.lat || x.lng !== y.lng) return false;
    if (x.address !== y.address || x.city !== y.city || x.cuisine !== y.cuisine || x.url !== y.url) return false;
    if ((x.place_id || null) !== (y.place_id || null)) return false;
    if ((x.name_key || null) !== (y.name_key || null)) return false;
  }
  return true;
}

/** True if `rowEls` maps to live `<tr>` nodes still in the document (not stale after innerHTML clears). */
function rowElsMapConnected() {
  const keys = Object.keys(rowEls);
  if (!keys.length) return false;
  return keys.every(k => {
    const tr = rowEls[k];
    return tr && tr.isConnected;
  });
}

function setRestaurants(items, { reselect = true } = {}) {
  // Order by rank just in case the loader didn't.
  const next = [...items].sort((a, b) => a.rank - b.rank);
  // When the payload matches what we already show, skip rebuilding the table —
  // but still assign `restaurants = next` so `loadOverlay` / toggles see DB fields
  // like `name_key` (migration 007). Returning early without updating `restaurants`
  // left stale objects without `name_key`, so visited matched on the map (markers
  // refreshed elsewhere) but not on `<tr>` rows.
  if (restaurantsEqual(restaurants, next) && rowElsMapConnected()) {
    restaurants = next;
    return;
  }
  restaurants = next;
  current = null;
  renderRows();
  renderMarkers();
  if (reselect && restaurants.length) {
    select(restaurants[0].rank);
  }
}

// ---------------------------------------------------------------------------
// Overlay loading: fetch visited/hearted for the overlay user (which may be
// the signed-in user or a viewed user) scoped to the current list.
// ---------------------------------------------------------------------------
async function loadOverlay() {
  if (!listMeta || !listMeta.id) {
    return;
  }
  const overlayUid = viewingUserId || currentUser?.id || null;
  if (!overlayUid) {
    if (!shouldUseLocalStorage()) clearLocalState();
    return;
  }

  try {
    const [vPack, hPack] = await Promise.all([
      fetchOverlayProgressSet('visited', overlayUid, listMeta.id, restaurants),
      fetchOverlayProgressSet('hearted', overlayUid, listMeta.id, restaurants),
    ]);

    // Important: if a fetch fails (RLS misconfig, transient outage, etc.),
    // DO NOT interpret that as "empty progress" — that would wipe the UI on
    // reload for affected accounts. Instead, keep whatever state we already
    // have (often from optimistic localStorage paint) and only overwrite when
    // we have a successful remote payload.
    // `null` = fetch failed (keep in-memory state). Empty `Set` = successful fetch with zero rows.
    // Never use `if (remoteVisited)` — empty Set is truthy and would call `applyVisitedSet(empty)`,
    // wiping progress (e.g. own profile URL `/you` where `shouldUseLocalStorage()` is false).
    const remoteVisited = vPack.error ? null : vPack.keys;
    const remoteHearted = hPack.error ? null : hPack.keys;
    if (vPack.error) console.warn('visited fetch failed', vPack.error.message || vPack.error);
    if (hPack.error) console.warn('hearted fetch failed', hPack.error.message || hPack.error);

    const ownOverlay = !!(currentUser && currentUser.id === overlayUid);

    if (ownOverlay) {
      // Merge any local-only name keys up to the cloud on first sync-in.
      // Pair each name key with a real display name drawn from the current
      // list (or the default seed) so the stored `name` column is readable.
      // Runs for every route where the overlay is the signed-in user (not only `/`),
      // so in-memory progress from `/` is not cleared when opening `/username`.
      // When the remote fetch failed (`null`), still try to push local keys — otherwise
      // a transient outage permanently skips the first cloud sync for that session.
      const visitLocalOnly = remoteVisited !== null ? [...visited].filter(k => !remoteVisited.has(k)) : [...visited];
      const heartLocalOnly = remoteHearted !== null ? [...hearted].filter(k => !remoteHearted.has(k)) : [...hearted];
      const rowMatchesKey = (x, kk) => {
        const kkt = String(kk).trim();
        if (!kkt) return false;
        return (
          (x.name_key != null && String(x.name_key).trim() === kkt)
          || progressKey(x.name) === progressKey(kk)
          || String(x.name).trim() === kkt
          || collapseMatchKey(x.name) === collapseMatchKey(kk)
          || (x.name_key != null && collapseMatchKey(String(x.name_key)) === collapseMatchKey(kk))
        );
      };
      const nameForKey = (k) => {
        const kk = String(k).trim();
        const r = restaurants.find(x => rowMatchesKey(x, kk))
          || DEFAULT_RESTAURANTS.find(x => rowMatchesKey(x, kk));
        return r ? r.name : k;
      };
      const rankRowForKey = (k) => {
        const kk = String(k).trim();
        const r = restaurants.find(x => rowMatchesKey(x, kk))
          || DEFAULT_RESTAURANTS.find(x => rowMatchesKey(x, kk));
        return r && listMeta.id ? { user_id: currentUser.id, list_id: listMeta.id, rank: r.rank } : null;
      };
      if (visitLocalOnly.length) {
        const rows = dedupeProgressNameRows(currentUser.id, visitLocalOnly, nameForKey);
        let { error } = await supabase.from('visited').upsert(rows, { onConflict: 'user_id,name_key' });
        if (error && isMissingProgressColumnError(error) && listMeta.id) {
          const legMap = new Map();
          for (const r of visitLocalOnly.map(rankRowForKey).filter(Boolean)) {
            legMap.set(`${r.list_id}\0${r.rank}`, r);
          }
          const leg = [...legMap.values()];
          if (leg.length) ({ error } = await supabase.from('visited').upsert(leg, { onConflict: 'user_id,list_id,rank' }));
        }
        if (error) {
          if (isRlsWriteDeniedError(error)) warnVisitedSyncBlocked(error, 'local visited upload');
          else console.warn('local visited upload skipped:', error.message);
        }
      }
      if (heartLocalOnly.length) {
        const rows = dedupeProgressNameRows(currentUser.id, heartLocalOnly, nameForKey);
        let { error } = await supabase.from('hearted').upsert(rows, { onConflict: 'user_id,name_key' });
        if (error && isMissingProgressColumnError(error) && listMeta.id) {
          const legMap = new Map();
          for (const r of heartLocalOnly.map(rankRowForKey).filter(Boolean)) {
            legMap.set(`${r.list_id}\0${r.rank}`, r);
          }
          const leg = [...legMap.values()];
          if (leg.length) ({ error } = await supabase.from('hearted').upsert(leg, { onConflict: 'user_id,list_id,rank' }));
        }
        if (error) {
          if (isRlsWriteDeniedError(error)) warnVisitedSyncBlocked(error, 'local hearted upload');
          else console.warn('local hearted upload skipped:', error.message);
        }
      }
      if (remoteVisited !== null) applyVisitedSet(new Set([...visited, ...remoteVisited]));
      else saveVisited(); // keep current UI counts in sync
      if (remoteHearted !== null) applyHeartedSet(new Set([...hearted, ...remoteHearted]));
      else saveHearted();
    } else {
      if (remoteVisited !== null) applyVisitedSet(remoteVisited);
      else saveVisited();
      if (remoteHearted !== null) applyHeartedSet(remoteHearted);
      else saveHearted();
    }
  } catch (e) {
    console.error('loadOverlay failed', e);
  }
}

// ---------------------------------------------------------------------------
// Boot orchestration.
// ---------------------------------------------------------------------------
async function applyRoute(nextRoute) {
  route = nextRoute;
  viewingUserId = null;
  viewingProfile = null;
  const myToken = ++routeToken;

  // Optimistic paint for the default list (and /<username> overlays of it):
  // render the seed array immediately so the page is interactive while the
  // Supabase round-trip happens.
  if (route.kind === 'default' || route.kind === 'user') {
    const seedFromStorage = route.kind === 'default'
      ? readStoredNameKeys(STORAGE_KEY_VISITED)
      : null;
    const heartFromStorage = route.kind === 'default'
      ? readStoredNameKeys(STORAGE_KEY_HEARTED)
      : null;

    listMeta = {
      id: null,
      slug: DEFAULT_LIST_SLUG,
      name: DEFAULT_LIST_NAME,
      owner_id: null,
      owner_username: DEFAULT_LIST_OWNER_USERNAME,
      isDefault: true,
      deleted_at: null,
    };
    setRestaurants(DEFAULT_RESTAURANTS);
    if (seedFromStorage) applyVisitedSet(seedFromStorage);
    if (heartFromStorage) applyHeartedSet(heartFromStorage);
  } else {
    listMeta = null;
    restaurants = [];
    rowEls = {};
    for (const m of Object.values(markers)) map.removeLayer(m);
    markers = {};
    tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">Loading…</td></tr>';
    info.innerHTML = '';
  }

  let result;
  try {
    result = await loadList(route);
  } catch (err) {
    return renderRouteError(err);
  }

  listMeta = result.list;
  setRestaurants(result.restaurants);

  if (result.overlayUserId) {
    viewingUserId = result.overlayUserId;
    viewingProfile = result.overlayProfile;
  }

  await loadOverlay();
  renderViewBanner();
  document.title = isDefaultList()
    ? `Top100SF — ${DEFAULT_LIST_NAME}`
    : `${listMeta.name} · Top100SF`;

  // After top-layer dialogs close or flex layout updates, Leaflet and the list
  // scrollport can keep stale dimensions until the next frame / interaction.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      map.invalidateSize();
      if (listBody) listBody.scrollTop = 0;
    });
  });

  // Fire-and-forget: fill in any missing coordinates for rows that have an
  // address. Uses the shared geocode_cache, so repeat visits are instant.
  backfillMissingCoordinates(myToken).catch(err => {
    console.warn('coordinate backfill failed', err);
  });
}

// ---------------------------------------------------------------------------
// Background geocode pass for rows saved without coordinates. Runs after the
// list has painted so the map fills in over time. Safe to call for any
// viewer: DB persistence silently no-ops for non-owners (RLS), but the
// in-memory markers always update so the current session sees pins.
// ---------------------------------------------------------------------------
async function backfillMissingCoordinates(token) {
  if (!listMeta || !listMeta.id) return;
  const listId = listMeta.id;
  const candidates = restaurants.filter(r =>
    (r.lat == null || r.lng == null) && buildGeocodeQuery(r)
  );
  if (!candidates.length) return;

  const canPersist = !!(currentUser && listMeta.owner_id && currentUser.id === listMeta.owner_id);

  for (const row of candidates) {
    if (token !== routeToken) return; // navigated away; abandon
    const query = buildGeocodeQuery(row);
    let result = null;
    try {
      result = await geocodeAddress(query, row);
    } catch (e) {
      console.warn(`geocode failed for #${row.rank} (${query})`, e);
      continue;
    }
    if (!result) continue;
    if (token !== routeToken) return;

    const live = restaurants.find(r => r.rank === row.rank);
    if (!live || live.lat != null || live.lng != null) continue;
    live.lat = result.lat;
    live.lng = result.lng;
    addMarkerForRow(live);

    if (canPersist) {
      supabase
        .from('list_items')
        .update({ lat: result.lat, lng: result.lng })
        .eq('list_id', listId)
        .eq('rank', row.rank)
        .then(({ error }) => {
          if (error) console.warn(`persist coord #${row.rank} failed`, error.message);
        });
    }
  }
}

function renderRouteError(err) {
  console.warn('route resolution failed', err);
  restaurants = [];
  rowEls = {};
  for (const m of Object.values(markers)) map.removeLayer(m);
  markers = {};
  tbody.innerHTML = '';
  info.innerHTML = '';
  document.body.classList.remove('viewing');

  let message = 'We couldn’t load that page.';
  let showUsername = null;
  if (err && err.code === 'user_not_found') {
    message = `No user named “${escapeHtml(err.username)}” yet.`;
  } else if (err && err.code === 'list_not_found') {
    message = `No list with slug “${escapeHtml(err.slug)}”.`;
    if (route.kind === 'user-list') showUsername = route.username;
  } else if (route && route.kind === 'invalid') {
    message = 'That URL doesn’t look right.';
  }

  viewBanner.hidden = false;
  viewBanner.innerHTML = `
    <span>${message}</span>
    <button id="go-home" type="button">Go home</button>
    ${showUsername ? `<button id="go-user" type="button">@${escapeHtml(showUsername)}</button>` : ''}
  `;
  viewBanner.querySelector('#go-home').addEventListener('click', () => {
    history.pushState({}, '', '/');
    applyRoute(parseRoute());
  });
  if (showUsername) {
    viewBanner.querySelector('#go-user').addEventListener('click', () => {
      history.pushState({}, '', `/${showUsername}`);
      applyRoute(parseRoute());
    });
  }
}

// ---------------------------------------------------------------------------
// View banner: shown when looking at someone else's overlay (read-only).
// ---------------------------------------------------------------------------
function renderViewBanner() {
  if (!viewingUserId) {
    viewBanner.hidden = true;
    viewBanner.innerHTML = '';
    document.body.classList.remove('viewing');
    return;
  }
  const ownsView = currentUser && currentUser.id === viewingUserId;
  if (ownsView) {
    document.body.classList.remove('viewing');
    viewBanner.hidden = true;
    viewBanner.innerHTML = '';
    return;
  }
  document.body.classList.add('viewing');
  const who = viewingProfile?.username
    ? '@' + escapeHtml(viewingProfile.username)
    : 'a friend';
  viewBanner.hidden = false;
  viewBanner.innerHTML = `
    <span>Viewing <span class="viewer-name">${who}</span>${listMeta && !isDefaultList() ? ` on ${escapeHtml(listMeta.name)}` : ''}</span>
    <button id="exit-view" type="button">${currentUser ? 'Back to my list' : 'Start your own'}</button>
  `;
  viewBanner.querySelector('#exit-view').addEventListener('click', exitViewingMode);
}

function exitViewingMode() {
  // Stay on the current list so the viewer sees their own overlay on it;
  // only fall back to the site root for the default list (which is the
  // same destination).
  const path = listMeta && !isDefaultList() ? `/list/${listMeta.slug}` : '/';
  history.pushState({}, '', path);
  applyRoute(parseRoute());
}

// ---------------------------------------------------------------------------
// Tooltip hint on first paint (kept from the original).
// ---------------------------------------------------------------------------
function showVisitedHint() {
  const checkBtn = document.querySelector('tbody tr .check');
  if (!checkBtn) return;
  const anchor = checkBtn.querySelector('svg') || checkBtn;
  const tooltip = document.createElement('div');
  tooltip.className = 'tooltip-bubble';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.textContent = 'Mark visited';
  document.body.appendChild(tooltip);

  function position() {
    const rect = anchor.getBoundingClientRect();
    tooltip.style.top = (rect.top - 6) + 'px';
    tooltip.style.left = Math.round(rect.left + rect.width / 2) + 'px';
  }
  position();
  requestAnimationFrame(() => tooltip.classList.add('visible'));

  let dismissed = false;
  function hide() {
    if (dismissed) return;
    dismissed = true;
    tooltip.classList.remove('visible');
    setTimeout(() => tooltip.remove(), 200);
    document.removeEventListener('pointerover', onPointer, true);
    document.removeEventListener('pointerdown', hide, true);
    window.removeEventListener('resize', position);
    document.removeEventListener('scroll', position, true);
    if (listBody) listBody.removeEventListener('scroll', onListScroll);
  }
  function onListScroll() {
    hide();
  }
  function onPointer(e) {
    const el = e.target.closest && e.target.closest('.icon-btn');
    if (el && el !== checkBtn) hide();
  }
  document.addEventListener('pointerover', onPointer, true);
  document.addEventListener('pointerdown', hide, true);
  window.addEventListener('resize', position);
  document.addEventListener('scroll', position, true);
  if (listBody) listBody.addEventListener('scroll', onListScroll, { passive: true });
  setTimeout(hide, 8000);
}

// ---------------------------------------------------------------------------
// Auth UI + flows. Signed-in users see a hamburger button that opens the
// menu dialog; signed-out users see the existing magic-link form.
// ---------------------------------------------------------------------------
const hamburgerSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

function renderAuthSignedIn() {
  // The menu shell is one expanding container: the hamburger button anchors
  // its top-right corner, and the menu body sits inside the same box so the
  // panel looks like the button physically grew into it rather than opening
  // a separate floating dropdown.
  authEl.innerHTML = `
    <div class="menu-shell" id="menu-shell" data-expanded="false">
      <div class="menu-header">
        <span class="menu-list-title" id="menu-list-title" aria-hidden="true"></span>
        <button id="menu-button" class="menu-button" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="menu-body" title="Open menu" aria-label="Open menu">
          ${hamburgerSvg}
        </button>
      </div>
      <div class="menu-body" id="menu-body" role="menu" hidden></div>
    </div>
  `;
  authEl.querySelector('#menu-button').addEventListener('click', toggleMenu);
}

// ---------------------------------------------------------------------------
// Hamburger menu controller. The shell (.menu-shell) contains both the
// trigger button and the menu body; we toggle data-expanded to grow/shrink
// it. Closes on outside click, Escape, or after any menu action.
// ---------------------------------------------------------------------------
function getMenuShell() { return document.getElementById('menu-shell'); }
function getMenuBody() { return document.getElementById('menu-body'); }
function isMenuOpen() {
  const shell = getMenuShell();
  return !!shell && shell.dataset.expanded === 'true';
}

function toggleMenu() {
  if (isMenuOpen()) closeMenu();
  else openMenu();
}

function setMenuTitle(name) {
  const el = document.getElementById('menu-list-title');
  if (!el) return;
  el.textContent = String(name || '');
}

function openMenu() {
  const shell = getMenuShell();
  const trigger = document.getElementById('menu-button');
  const body = getMenuBody();
  if (!shell || !trigger || !body) return;
  shell.dataset.expanded = 'true';
  trigger.setAttribute('aria-expanded', 'true');
  body.hidden = false;
  setMenuTitle(listMeta?.name || '');
  showMainPanel();
  setTimeout(() => document.addEventListener('pointerdown', maybeCloseOnOutside, true), 0);
  document.addEventListener('keydown', maybeCloseOnEscape, true);
}

function closeMenu() {
  const shell = getMenuShell();
  const trigger = document.getElementById('menu-button');
  const body = getMenuBody();
  if (shell) shell.dataset.expanded = 'false';
  if (trigger) trigger.setAttribute('aria-expanded', 'false');
  if (body) body.hidden = true;
  setMenuTitle('');
  document.removeEventListener('pointerdown', maybeCloseOnOutside, true);
  document.removeEventListener('keydown', maybeCloseOnEscape, true);
}

function maybeCloseOnOutside(e) {
  const shell = getMenuShell();
  if (shell && shell.contains(e.target)) return;
  closeMenu();
}

function maybeCloseOnEscape(e) {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeMenu();
  }
}

function showMainPanel() {
  const menuBody = getMenuBody();
  if (!menuBody) return;
  const isOwner = currentUser && listMeta && listMeta.owner_id === currentUser.id;
  // The username-display row doubles as the "edit username" trigger. On
  // hover/focus we swap its contents for a single "Choose username" label so
  // the affordance is obvious without needing a second redundant menu item.
  const usernameRow = currentProfile?.username
    ? `<button class="username-display" type="button" data-action="edit-username">
         <span class="username-display-current">
           <span class="at">@${escapeHtml(currentProfile.username)}</span>
           <span class="email">${escapeHtml(currentUser?.email || '')}</span>
         </span>
         <span class="username-display-hover">Choose username</span>
       </button>`
    : `<button class="username-display" type="button" data-action="edit-username">
         <span class="username-display-current">
           <span class="at">${escapeHtml(currentUser?.email || '')}</span>
         </span>
         <span class="username-display-hover">Choose username</span>
       </button>`;

  const listName = listMeta?.name || '';
  const listSection = listName ? `
    <div class="menu-section" role="menu">
      ${isOwner ? `
      <button class="menu-item" type="button" role="menuitem" data-action="edit-list">
        <span class="menu-item-strong">Edit</span>
      </button>
      ` : ''}
      <button class="menu-item" type="button" role="menuitem" data-action="share">
        <span class="menu-item-strong">Share</span>
      </button>
    </div>
  ` : '';

  menuBody.innerHTML = `
    ${listSection}
    <div class="menu-section" role="menu">
      <button class="menu-item" type="button" role="menuitem" data-action="all-lists">
        <span class="menu-item-strong">Browse</span>
      </button>
      <button class="menu-item" type="button" role="menuitem" data-action="new-list">
        <span class="menu-item-strong">Create</span>
      </button>
    </div>
    <div class="menu-section">
      ${usernameRow}
      <button class="menu-item menu-item-danger" type="button" role="menuitem" data-action="signout">
        <span class="menu-item-strong">Sign out</span>
      </button>
    </div>
  `;

  menuBody.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => handleMenuAction(btn.dataset.action));
  });
}

function handleMenuAction(action) {
  if (action === 'edit-username') return showUsernamePanel();
  if (action === 'share') return showSharePanel();
  if (action === 'all-lists') {
    closeMenu();
    return openAllListsDialog();
  }
  if (action === 'new-list') {
    closeMenu();
    return openNewListDialog();
  }
  if (action === 'edit-list') {
    closeMenu();
    return openEditListDialog(listMeta);
  }
  if (action === 'signout') {
    closeMenu();
    return handleSignOut();
  }
}

// --- Username editor sub-panel ---------------------------------------------
function showUsernamePanel() {
  const menuBody = getMenuBody();
  if (!menuBody) return;
  const initial = currentProfile?.username || '';
  menuBody.innerHTML = `
    <form class="menu-form" id="username-form" autocomplete="off" novalidate>
      <label for="username-input">Username</label>
      <input type="text" id="username-input" name="username" pattern="[a-zA-Z0-9]{2,32}" minlength="2" maxlength="32" required value="${escapeHtml(initial)}" autofocus>
      <div class="form-hint" id="username-hint">2&ndash;32 letters or numbers. Your link becomes top100sf.com/&lt;username&gt;.</div>
      <div class="menu-form-actions">
        <button type="button" data-action="back">Cancel</button>
        <button type="submit" class="primary" id="username-save" disabled>Save</button>
      </div>
    </form>
  `;
  menuBody.querySelectorAll('button[data-action="back"]').forEach((b) => b.addEventListener('click', showMainPanel));
  const input = menuBody.querySelector('#username-input');
  const hint = menuBody.querySelector('#username-hint');
  const save = menuBody.querySelector('#username-save');
  const form = menuBody.querySelector('#username-form');

  let lastChecked = '';
  let checkTimer = null;
  let inFlight = 0;

  function setHint(msg, kind = '') {
    hint.textContent = msg;
    hint.className = 'form-hint' + (kind ? ' ' + kind : '');
  }

  async function check(value) {
    if (!isValidUsername(value)) {
      save.disabled = true;
      setHint('Use 2–32 letters or numbers only.', 'err');
      return;
    }
    if (RESERVED_SLUGS.has(value.toLowerCase())) {
      save.disabled = true;
      setHint('That username is reserved.', 'err');
      return;
    }
    if (value === currentProfile?.username) {
      save.disabled = true;
      setHint('This is your current username.');
      return;
    }
    setHint('Checking…');
    save.disabled = true;
    const seq = ++inFlight;
    const { data, error } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('username', value)
      .maybeSingle();
    if (seq !== inFlight) return; // stale
    if (error) {
      setHint('Could not check availability.', 'err');
      save.disabled = true;
      return;
    }
    if (data && data.user_id !== currentUser?.id) {
      setHint('That username is taken.', 'err');
      save.disabled = true;
      return;
    }
    setHint('Available.', 'ok');
    save.disabled = false;
    lastChecked = value;
  }

  input.addEventListener('input', () => {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(() => check(input.value.trim()), 350);
  });
  input.addEventListener('blur', () => {
    clearTimeout(checkTimer);
    check(input.value.trim());
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const value = input.value.trim();
    if (value !== lastChecked) await check(value);
    if (save.disabled) return;
    save.disabled = true;
    save.textContent = 'Saving…';
    const { error } = await supabase
      .from('profiles')
      .upsert({ user_id: currentUser.id, username: value });
    if (error) {
      setHint('Save failed: ' + error.message, 'err');
      save.disabled = false;
      save.textContent = 'Save';
      return;
    }
    currentProfile = { user_id: currentUser.id, username: value };
    // Mirror the username into public_lists.display so legacy ?u= viewers
    // see the right name. Best-effort; ignore failures.
    if (sharingEnabled) {
      supabase
        .from('public_lists')
        .upsert({ user_id: currentUser.id, display: value })
        .then(({ error }) => { if (error) console.warn('public_lists.display sync failed', error.message); });
    }
    renderAuthSignedIn();
    closeMenu();
  });

  // Initial check so Save state is sensible.
  check(input.value.trim());
}

// --- Share panel -----------------------------------------------------------
function showSharePanel() {
  const menuBody = getMenuBody();
  if (!menuBody) return;
  const hasUsername = !!currentProfile?.username;
  const hasOverlay = visited.size > 0 || hearted.size > 0;
  const progressShareUrl = (() => {
    if (hasUsername) {
      const slug = isDefaultList() ? '' : '/' + listMeta.slug;
      return window.location.origin + '/' + currentProfile.username + slug;
    }
    const u = new URL(window.location.origin);
    u.searchParams.set('u', currentUser.id);
    if (!isDefaultList()) u.searchParams.set('list', listMeta.slug);
    return u.toString();
  })();
  const progressDisabled = !hasOverlay;
  const progressNote = !hasUsername
    ? ''
    : (progressDisabled ? 'Mark a few visited or favorited first.' : 'Share list visits & likes with friends');

  const listLabel = listMeta?.slug || '';
  menuBody.innerHTML = `
    <div class="share-option-title">Share list${listLabel ? `: ${escapeHtml(listLabel)}` : ''}</div>
    ${progressNote ? `<div class="share-option-sub">${escapeHtml(progressNote)}</div>` : ''}
    ${progressDisabled ? '' : `
      <div class="share-option-row">
        <input type="text" id="share-progress-url" readonly value="${escapeHtml(progressShareUrl)}">
        <button type="button" data-copy="share-progress-url">Copy</button>
      </div>
    `}
  `;
  menuBody.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const input = menuBody.querySelector('#' + btn.dataset.copy);
      if (!input) return;
      try { await navigator.clipboard.writeText(input.value); }
      catch { input.select(); try { document.execCommand('copy'); } catch {} }
      const original = btn.textContent;
      btn.textContent = 'Copied';
      setTimeout(() => { if (btn.isConnected) btn.textContent = original; }, 1500);
    });
  });

  if (!hasOverlay && hasUsername) {
    // Already disabled visually; nothing else to do.
  }

  // Lazy-enable sharing in the legacy public_lists table when the user
  // explicitly clicks copy on the progress link without a username yet.
  if (!hasUsername) {
    const progressBtn = menuBody.querySelector('[data-copy="share-progress-url"]');
    if (!progressBtn) return;
    progressBtn.addEventListener('click', async () => {
      if (sharingEnabled || !currentUser) return;
      const display = currentUser.email;
      await supabase.from('public_lists').upsert({ user_id: currentUser.id, display });
      sharingEnabled = true;
    }, { once: true });
  }
}

async function handleSignOut() {
  const who = currentProfile?.username
    ? '@' + currentProfile.username
    : (currentUser?.email || 'this account');
  const ok = await confirmDialog({
    message: `Sign out of ${who}?`,
    confirmLabel: 'Sign out',
  });
  if (ok) await supabase.auth.signOut();
}

async function handleDeleteList() {
  if (!listMeta || !currentUser) return;
  if (isDefaultList()) {
    await confirmDialog({
      message: 'The site-wide default list cannot be deleted.',
      confirmLabel: 'OK',
      cancelLabel: '',
    });
    return;
  }
  const ok = await confirmDialog({
    message: `Delete “${listMeta.name}”? This hides it for everyone tracking progress on it.`,
    confirmLabel: 'Delete',
  });
  if (!ok) return;
  const { error } = await supabase
    .from('lists')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', listMeta.id);
  if (error) {
    alert('Delete failed: ' + error.message);
    return;
  }
  if (newListDialog.open) newListDialog.close('cancel');
  history.pushState({}, '', '/');
  applyRoute(parseRoute());
}

// ---------------------------------------------------------------------------
// New list / Edit list modal (Phase 5)
//
// Shared modal: pasted JSON (CSV via upload → JSON in textarea) -> normalized rows -> optional
// geocoding -> insert into `lists` + `list_items` (Create) or replace_list_items
// RPC (Edit). 100-item hard cap, 20-list-per-user cap.
// ---------------------------------------------------------------------------
const LIST_ITEM_CAP = 100;
const LIST_PER_USER_CAP = 20;

const COLUMN_ALIASES = {
  name:     ['name', 'restaurant', 'title'],
  address:  ['address', 'street', 'addr', 'location'],
  city:     ['city', 'town', 'locality'],
  cuisine:  ['cuisine', 'category', 'type', 'food'],
  url:      ['url', 'website', 'link', 'site'],
  lat:      ['lat', 'latitude'],
  lng:      ['lng', 'lon', 'long', 'longitude'],
  place_id: [
    'place_id',
    'google_place_id',
    'google_maps_place_id',
    'maps_place_id',
    'placeid',
    'placeId',
  ],
};

const CSV_TEMPLATE = `name,address,city,cuisine,url,lat,lng,google_place_id
Tartine Bakery,600 Guerrero St,San Francisco,Bakery,https://tartinebakery.com,37.7615,-122.4241,
Zuni Cafe,1658 Market St,San Francisco,Californian,https://zunicafe.com,37.7736,-122.4216,
`;

const JSON_TEMPLATE = JSON.stringify([
  { name: 'Tartine Bakery', address: '600 Guerrero St', city: 'San Francisco', cuisine: 'Bakery', url: 'https://tartinebakery.com', lat: 37.7615, lng: -122.4241 },
  { name: 'Zuni Cafe', address: '1658 Market St', city: 'San Francisco', cuisine: 'Californian', url: 'https://zunicafe.com', lat: 37.7736, lng: -122.4216 },
], null, 2);

const newListDialog = document.getElementById('new-list-dialog');
const newListBody = document.getElementById('new-list-body');
/** Cleared when the list modal body is re-rendered. */
let listModalNameBlurTimer = null;
/** Set while create/edit list modal is mounted; used for backdrop / Escape / Cancel close guard. */
let listModalTryClose = null;

function disposeListDataEditor() {
  if (listModalNameBlurTimer != null) {
    clearTimeout(listModalNameBlurTimer);
    listModalNameBlurTimer = null;
  }
  listModalTryClose = null;
}

/** Aborted each time the create/edit list modal body is re-rendered so outside-click closes only one listener. */
let newListPlaceSearchOutsideAbort = null;

newListDialog.addEventListener('click', (e) => {
  if (e.target !== newListDialog) return;
  if (listModalTryClose) void listModalTryClose();
  else newListDialog.close('cancel');
});

newListDialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  if (listModalTryClose) void listModalTryClose();
  else newListDialog.close('cancel');
});

function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}

function aliasMap() {
  // Flatten the alias table into a (lower-case alias) -> canonical map.
  const m = new Map();
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const a of aliases) m.set(a.toLowerCase(), canonical);
  }
  return m;
}

function normalizeKeys(row) {
  const out = {};
  const aliases = aliasMap();
  for (const [k, v] of Object.entries(row)) {
    if (v == null || String(v).trim() === '') continue;
    const canon = aliases.get(String(k).trim().toLowerCase());
    if (!canon) continue;
    out[canon] = typeof v === 'string' ? v.trim() : v;
  }
  return out;
}

// --- Google Places (optional; meta google-places-api-key) -------------------
function barePlaceId(resourceOrId) {
  const s = String(resourceOrId || '');
  return s.startsWith('places/') ? s.slice('places/'.length) : s;
}

function pickAddressComponent(components, ...wantTypes) {
  if (!Array.isArray(components)) return '';
  for (const t of wantTypes) {
    const c = components.find(x => Array.isArray(x.types) && x.types.includes(t));
    if (c?.longText) return c.longText;
    if (c?.shortText) return c.shortText;
  }
  return '';
}

function cuisineFromTypes(types) {
  if (!Array.isArray(types) || !types.length) return '';
  const hit = types.find(x => typeof x === 'string' && x.endsWith('_restaurant') && x !== 'restaurant');
  if (hit) {
    return hit
      .replace(/_restaurant$/i, '')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, ch => ch.toUpperCase());
  }
  if (types.includes('restaurant')) return 'Restaurant';
  return String(types[0] || '').replace(/_/g, ' ');
}

function placeDetailsToRow(placeResourceName, data) {
  const pid = barePlaceId(placeResourceName);
  const name = data?.displayName?.text || 'Unknown';
  const comps = data?.addressComponents || [];
  const locality = pickAddressComponent(comps, 'locality', 'sublocality_level_1', 'postal_town', 'neighborhood');
  const route = pickAddressComponent(comps, 'route');
  const streetNum = pickAddressComponent(comps, 'street_number');
  const streetLine = [streetNum, route].filter(Boolean).join(' ').trim();
  const address = streetLine || data?.formattedAddress || '';
  const city = locality || '';
  const lat = data?.location?.latitude;
  const lng = data?.location?.longitude;
  const url = data?.websiteUri || data?.googleMapsUri || '';
  return {
    rank: 0,
    name,
    address,
    city,
    cuisine: cuisineFromTypes(data?.types),
    url,
    lat: Number.isFinite(Number(lat)) ? Number(lat) : null,
    lng: Number.isFinite(Number(lng)) ? Number(lng) : null,
    place_id: pid,
  };
}

async function fetchGooglePlaceDetails(placeResourceName, apiKey) {
  // REST path is `/v1/places/{placeId}` — not `/v1/places%2F{placeId}` (encoding the slash breaks CORS in browsers).
  const bare = barePlaceId(placeResourceName);
  if (!bare) throw new Error('Missing Google place id for details request.');
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(bare)}`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,addressComponents,location,websiteUri,googleMapsUri,types',
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Place details ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchGooglePlacesTextSearch(query, apiKey) {
  const body = {
    textQuery: query.trim(),
    languageCode: 'en',
    pageSize: 10,
  };
  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Places search ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data.places) ? data.places : [];
}

/** Safe fragment for Postgres `ILIKE` user-supplied text (no `%` / `_` wildcards). */
function ilikeSearchFragment(raw) {
  return String(raw || '')
    .trim()
    .replace(/%/g, '')
    .replace(/_/g, '')
    .replace(/,/g, ' ')
    .trim();
}

/**
 * Match saved `places` rows by name / address / city / place_id without a single `.or()` filter
 * (avoids PostgREST URL-encoding edge cases for `ilike` + `%`).
 */
async function searchSavedPlaces(query) {
  const fragment = ilikeSearchFragment(query);
  if (!fragment) return { rows: [], error: null };
  const pat = `%${fragment}%`;
  const sel = () => supabase.from('places').select('place_id, name, address, city').limit(8);
  const [byName, byAddr, byCity, byPid] = await Promise.all([
    sel().ilike('name', pat),
    sel().ilike('address', pat),
    sel().ilike('city', pat),
    sel().ilike('place_id', pat),
  ]);
  const error = byName.error || byAddr.error || byCity.error || byPid.error;
  if (error) {
    console.warn('saved places search', error.message);
    return { rows: [], error };
  }
  const map = new Map();
  for (const list of [byName.data, byAddr.data, byCity.data, byPid.data]) {
    for (const row of list || []) {
      if (row?.place_id) map.set(row.place_id, row);
    }
  }
  return { rows: [...map.values()].slice(0, 8), error: null };
}

/** Stable identity for a location row (search dedupe, parse dedupe, “already on list”). */
function locationIdentityKey(row) {
  const barePid = row.place_id ? barePlaceId(row.place_id) : '';
  if (barePid) return `pid:${barePid}`;
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return `geo:${norm(row.name)}|${norm(row.address)}|${norm(row.city)}`;
}

/**
 * Search rows already on users' lists (`list_items`). This is what people usually mean by
 * "in the database"; the `places` table is only a Google-place cache filled after lookups.
 */
async function searchListItemsForPlacePicker(query) {
  const fragment = ilikeSearchFragment(query);
  if (!fragment) return { rows: [], error: null };
  const pat = `%${fragment}%`;
  const sel = () =>
    supabase
      .from('list_items')
      .select('list_id, rank, name, address, city, place_id, url, lat, lng, cuisine')
      .limit(8);
  const [byName, byAddr, byCity] = await Promise.all([
    sel().ilike('name', pat),
    sel().ilike('address', pat),
    sel().ilike('city', pat),
  ]);
  const error = byName.error || byAddr.error || byCity.error;
  if (error) {
    console.warn('list items place search', error.message);
    return { rows: [], error };
  }
  const map = new Map();
  for (const list of [byName.data, byAddr.data, byCity.data]) {
    for (const row of list || []) {
      if (!row?.list_id) continue;
      const k = locationIdentityKey(row);
      if (map.has(k)) continue;
      map.set(k, row);
    }
  }
  return { rows: [...map.values()].slice(0, 8), error: null };
}

async function resolvePlaceRow(placeResourceId, apiKey) {
  const bare = barePlaceId(placeResourceId);
  const { data: cached } = await supabase.from('places').select('*').eq('place_id', bare).maybeSingle();
  if (cached?.name) {
    return {
      rank: 0,
      name: cached.name,
      address: cached.address || '',
      city: cached.city || '',
      cuisine: cached.cuisine || '',
      url: cached.url || '',
      lat: cached.lat != null ? Number(cached.lat) : null,
      lng: cached.lng != null ? Number(cached.lng) : null,
      place_id: bare,
    };
  }
  if (!apiKey) throw new Error('Google Places API key is not added to this page.');
  const nameParam = placeResourceId.startsWith('places/') ? placeResourceId : `places/${placeResourceId}`;
  const d = await fetchGooglePlaceDetails(nameParam, apiKey);
  const row = placeDetailsToRow(nameParam, d);
  await supabase.from('places').upsert({
    place_id: bare,
    name: row.name,
    address: row.address || null,
    city: row.city || null,
    cuisine: row.cuisine || null,
    url: row.url || null,
    lat: row.lat,
    lng: row.lng,
    types: d.types || null,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'place_id' });
  return row;
}

async function searchPlacesCombined(query) {
  const key = getGooglePlacesApiKey();
  const out = [];
  const seen = new Set();
  let savedError = null;
  let listItemsError = null;
  const [listsRes, saved] = await Promise.all([
    searchListItemsForPlacePicker(query),
    searchSavedPlaces(query),
  ]);
  if (listsRes.error) listItemsError = listsRes.error.message || String(listsRes.error);
  if (saved.error) savedError = saved.error.message || String(saved.error);

  for (const r of listsRes.rows) {
    const barePid = r.place_id ? barePlaceId(r.place_id) : '';
    const dedupeKey = barePid ? `places/${barePid}` : `li:${r.list_id}:${r.rank}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const id = barePid ? `places/${barePid}` : `list-item:${r.list_id}:${r.rank}`;
    out.push({
      id,
      displayName: { text: r.name },
      formattedAddress: [r.address, r.city].filter(Boolean).join(', ') || r.name,
      source: 'list',
      directRow: barePid
        ? null
        : {
          name: r.name,
          address: r.address || '',
          city: r.city || '',
          cuisine: r.cuisine || '',
          url: r.url || '',
          lat: r.lat != null ? Number(r.lat) : null,
          lng: r.lng != null ? Number(r.lng) : null,
          place_id: null,
        },
    });
  }

  for (const p of saved.rows) {
    const bare = barePlaceId(p.place_id);
    if (!bare) continue;
    const id = `places/${bare}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      displayName: { text: p.name },
      formattedAddress: [p.address, p.city].filter(Boolean).join(', ') || p.name,
      source: 'saved',
    });
  }
  return { places: out, hasGoogleKey: !!key, savedError, listItemsError };
}

/** Google Text Search only (call after user explicitly requests it). */
async function searchGooglePlacesForPicker(query) {
  const key = getGooglePlacesApiKey();
  if (!key) return { places: [], googleError: null };
  try {
    const out = [];
    for (const g of await fetchGooglePlacesTextSearch(query, key)) {
      const bare = barePlaceId(g?.id || g?.name || '');
      if (!bare) continue;
      const id = `places/${bare}`;
      out.push({
        ...g,
        id,
        source: 'google',
      });
    }
    return { places: out, googleError: null };
  } catch (e) {
    console.warn('Google text search failed', e);
    return { places: [], googleError: e?.message || String(e) };
  }
}

function appendRowToLocationsTextarea(itemsInput, row) {
  const obj = {
    name: row.name,
    address: row.address || '',
    city: row.city || '',
    cuisine: row.cuisine || '',
    url: row.url || '',
    lat: row.lat,
    lng: row.lng,
  };
  if (row.place_id) obj.place_id = row.place_id;
  const t = itemsInput.value.trim();
  let arr = [];
  if (t) {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) throw new Error('Locations JSON must be an array.');
    arr = parsed;
  }
  arr.push(obj);
  itemsInput.value = JSON.stringify(arr, null, 2);
}

/** Strip internal `rank` for JSON in the textarea (same shape as templates / API round-trip). */
function parsedRowsToJsonTextareaValue(rows) {
  return JSON.stringify(
    rows.map(({ rank, ...r }) => r),
    null,
    2,
  );
}

function parsePayload(text, format) {
  const errors = [];
  const rawRows = [];
  if (format === 'json') {
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      errors.push('Invalid JSON: ' + e.message);
      return { rows: [], errors, truncated: false };
    }
    if (!Array.isArray(parsed)) {
      errors.push('JSON root must be an array of objects.');
      return { rows: [], errors, truncated: false };
    }
    parsed.forEach((row, i) => {
      if (!row || typeof row !== 'object') {
        errors.push(`Row ${i + 1}: not an object`);
        return;
      }
      rawRows.push(row);
    });
  } else {
    const result = Papa.parse(text.trim(), { header: true, skipEmptyLines: true });
    for (const err of result.errors || []) {
      errors.push(`CSV row ${err.row + 1}: ${err.message}`);
    }
    for (const r of result.data || []) rawRows.push(r);
  }

  const truncated = rawRows.length > LIST_ITEM_CAP;
  const rows = [];
  const seenIdentity = new Set();
  let duplicatesSkipped = 0;
  rawRows.slice(0, LIST_ITEM_CAP).forEach((raw, i) => {
    const normalized = normalizeKeys(raw);
    if (!normalized.name) {
      errors.push(`Row ${i + 1}: missing name`);
      return;
    }
    const lat = normalized.lat != null ? Number(normalized.lat) : null;
    const lng = normalized.lng != null ? Number(normalized.lng) : null;
    const pid = normalized.place_id != null && String(normalized.place_id).trim() !== ''
      ? String(normalized.place_id).trim()
      : null;
    const candidate = {
      name: normalized.name,
      address: normalized.address || '',
      city: normalized.city || '',
      cuisine: normalized.cuisine || '',
      url: normalized.url || '',
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      place_id: pid,
    };
    const idKey = locationIdentityKey(candidate);
    if (seenIdentity.has(idKey)) {
      duplicatesSkipped += 1;
      return;
    }
    seenIdentity.add(idKey);
    rows.push({
      rank: rows.length + 1,
      ...candidate,
    });
  });

  if (duplicatesSkipped > 0) {
    errors.push(
      `Skipped ${duplicatesSkipped} duplicate row(s) (same Google Maps venue id or same name/address/city as an earlier row).`,
    );
  }
  if (truncated) {
    errors.push(`Rows beyond ${LIST_ITEM_CAP} were dropped (lists are capped at ${LIST_ITEM_CAP}).`);
  }

  return { rows, errors, truncated };
}

/** Parsed rows are OK to save; duplicate-skip messages are informational only. */
function parsePayloadAllowsSave(result) {
  if (!result?.rows?.length) return false;
  const blocking = (result.errors || []).filter(
    (e) => !/^Skipped \d+ duplicate row\(s\)/.test(e),
  );
  return blocking.length === 0;
}

// --- Geocoder --------------------------------------------------------------
// We use Photon (https://photon.komoot.io) rather than Nominatim directly:
// - Photon sets Access-Control-Allow-Origin: *, so browsers can call it.
// - The public Nominatim endpoint rate-limits and does not include CORS on
//   its 429 responses, so from a browser those requests just fail.
// - Photon is backed by OSM data, so result quality is comparable.
const PHOTON_ENDPOINT = 'https://photon.komoot.io/api/';
const GEOCODE_MIN_INTERVAL_MS = 300; // be polite; Photon has no hard limit
let lastGeocodeAt = 0;

async function photonLookup(query, { limit = 5 } = {}) {
  const now = Date.now();
  const wait = Math.max(0, lastGeocodeAt + GEOCODE_MIN_INTERVAL_MS - now);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  const url = `${PHOTON_ENDPOINT}?q=${encodeURIComponent(query)}&limit=${limit}&lang=en`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Photon ${res.status}`);
  const data = await res.json();
  if (!data || !Array.isArray(data.features)) return [];
  return data.features;
}

function photonCoords(feature) {
  const coords = feature?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const [lng, lat] = coords.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

// Rank Photon features against the row's name/address/city so we prefer
// the POI that actually matches, not just the first hit (Photon often
// surfaces partial-street matches in the wrong borough).
function scorePhotonFeature(feature, row) {
  const p = feature?.properties || {};
  const wantName = (row?.name || '').toLowerCase().trim();
  const wantAddr = (row?.address || '').toLowerCase();
  const wantCity = (row?.city || '').toLowerCase();
  const name = (p.name || '').toLowerCase();
  const street = (p.street || '').toLowerCase();
  const housenumber = (p.housenumber || '').toLowerCase();
  const city = (p.city || p.district || p.locality || '').toLowerCase();
  let score = 0;
  if (wantName && name) {
    if (name === wantName) score += 200;
    else if (name.includes(wantName) || wantName.includes(name)) score += 80;
  }
  if (housenumber && wantAddr.startsWith(housenumber + ' ')) score += 40;
  if (street && wantAddr.includes(street)) score += 30;
  if (wantCity && city) {
    if (wantCity === city || wantCity.includes(city) || city.includes(wantCity)) score += 20;
  }
  return score;
}

async function geocodeAddress(query, row = null) {
  const trimmed = String(query || '').trim();
  if (!trimmed) return null;
  const cacheRes = await supabase
    .from('geocode_cache')
    .select('lat, lng')
    .eq('query', trimmed)
    .maybeSingle();
  if (cacheRes.data) return { lat: cacheRes.data.lat, lng: cacheRes.data.lng };

  let features;
  try {
    features = await photonLookup(trimmed);
  } catch (e) {
    throw e;
  }
  if (!features.length) return null;

  let best = features[0];
  if (row) {
    let bestScore = -1;
    for (const f of features) {
      const s = scorePhotonFeature(f, row);
      if (s > bestScore) { bestScore = s; best = f; }
    }
  }
  const coords = photonCoords(best);
  if (!coords) return null;

  await supabase.from('geocode_cache').insert({ query: trimmed, lat: coords.lat, lng: coords.lng });
  return coords;
}

// Include the POI name so Photon can match the restaurant node directly
// (OSM has many restaurants tagged by name). Falls back gracefully when
// name is missing.
function buildGeocodeQuery(row) {
  const parts = [row.name, row.address, row.city].filter(Boolean);
  return parts.join(', ');
}

async function geocodeRows(rows, onProgress) {
  const missing = rows.filter(r => r.lat == null || r.lng == null);
  const failed = [];
  let done = 0;
  for (const row of missing) {
    const query = buildGeocodeQuery(row);
    if (!query) {
      failed.push({ rank: row.rank, query: '(no address)' });
      done++;
      onProgress(done, missing.length);
      continue;
    }
    try {
      const result = await geocodeAddress(query, row);
      if (result) {
        row.lat = result.lat;
        row.lng = result.lng;
      } else {
        failed.push({ rank: row.rank, query });
      }
    } catch (e) {
      failed.push({ rank: row.rank, query, error: e.message });
    }
    done++;
    onProgress(done, missing.length);
  }
  return failed;
}

// --- Modal renderer --------------------------------------------------------
async function openNewListDialog() {
  if (!currentUser) {
    alert('Sign in first to create a list.');
    return;
  }
  await renderListDialog({ mode: 'create' });
  newListDialog.showModal();
}

async function openEditListDialog(list) {
  if (!list || !currentUser || list.owner_id !== currentUser.id) return;
  let items = [];
  try {
    items = await fetchListItems(list.id);
  } catch (e) {
    alert('Could not load list items: ' + e.message);
    return;
  }
  await renderListDialog({ mode: 'edit', list, items });
  newListDialog.showModal();
}

async function renderListDialog({ mode, list = null, items = [] }) {
  disposeListDataEditor();
  const isEdit = mode === 'edit';
  const initialName = isEdit ? list.name : '';
  const initialSlug = isEdit ? list.slug : slugify(initialName);
  const initialJson = isEdit ? JSON.stringify(items.map(i => ({
    name: i.name,
    address: i.address,
    city: i.city,
    cuisine: i.cuisine,
    url: i.url,
    lat: i.lat,
    lng: i.lng,
    ...(i.place_id ? { place_id: i.place_id } : {}),
  })), null, 2) : '';

  newListBody.innerHTML = `
    <h2 class="modal-title" id="new-list-title">${isEdit ? 'Edit list' : 'Create list'}</h2>
    <p class="modal-sub">Add up to ${LIST_ITEM_CAP} locations per list. Use the search field or paste location data directly. Parse and save to create your list. Limit of ${LIST_PER_USER_CAP} lists per user.</p>
    <form id="new-list-form" novalidate>
      <div class="modal-field">
        <label for="list-name">Name</label>
        <input type="text" id="list-name" name="name" required value="${escapeHtml(initialName)}">
        <input type="hidden" id="list-slug" name="slug" value="${escapeHtml(initialSlug)}">
        <div class="list-slug-meta-row">
          <div class="field-hint list-slug-status" id="list-slug-status" aria-live="polite"></div>
          <div class="field-hint list-slug-preview" id="list-slug-preview"></div>
        </div>
      </div>
      <div class="modal-field place-add-field" id="place-add-block">
        <label for="place-search-q">Add places</label>
        <div class="place-search-combobox" id="place-search-combobox">
          <div class="place-search-row">
            <input type="search" id="place-search-q" placeholder="Type to search…" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="place-search-results" aria-haspopup="listbox">
          </div>
          <div id="place-search-dropdown" class="place-search-dropdown" hidden>
            <div id="place-search-status" class="place-search-dropdown-status" role="status" aria-live="polite" hidden></div>
            <ul id="place-search-results" class="place-search-results" role="listbox" aria-label="Place matches" hidden></ul>
          </div>
        </div>
      </div>
      <div class="modal-field">
        <div class="list-data-label-row">
          <span id="list-data-label-text" class="list-data-heading">List data</span>
          <div class="list-data-csv-tools" aria-label="CSV helpers">
            <button type="button" class="list-csv-tool-btn" id="csv-template-download">CSV template</button>
            <button type="button" class="list-csv-tool-btn" id="csv-upload-trigger">Upload CSV…</button>
            <input type="file" id="csv-file-input" accept=".csv,text/csv" hidden>
          </div>
        </div>
        <textarea id="list-items" class="list-items-textarea" name="items" required rows="14" aria-labelledby="list-data-label-text" spellcheck="false"></textarea>
      </div>
      <div class="parse-summary" id="parse-summary" hidden></div>
      <div class="menu-form-actions">
        ${isEdit && !isDefaultList() ? `<button type="button" class="danger-left" id="delete-list">Delete</button>` : ''}
        <button type="button" id="cancel-list">Cancel</button>
        <button type="button" class="primary list-primary-action" id="list-primary-action" data-mode="parse" disabled>Parse</button>
      </div>
    </form>
  `;

  const form = newListBody.querySelector('#new-list-form');
  const nameInput = newListBody.querySelector('#list-name');
  const slugInput = newListBody.querySelector('#list-slug');
  const initialSlugWhenOpened = slugInput.value.trim();
  const slugStatusEl = newListBody.querySelector('#list-slug-status');
  const slugPreviewEl = newListBody.querySelector('#list-slug-preview');
  const summary = newListBody.querySelector('#parse-summary');
  const primaryBtn = newListBody.querySelector('#list-primary-action');
  const cancelBtn = newListBody.querySelector('#cancel-list');
  const csvTemplateDownloadBtn = newListBody.querySelector('#csv-template-download');
  const csvUploadTriggerBtn = newListBody.querySelector('#csv-upload-trigger');
  const csvFileInput = newListBody.querySelector('#csv-file-input');
  /** @type {HTMLTextAreaElement} */
  const itemsInput = newListBody.querySelector('#list-items');
  itemsInput.placeholder = JSON_TEMPLATE;
  itemsInput.value = initialJson;

  let parsedRows = isEdit
    ? items.map((it, i) => ({
      rank: i + 1,
      name: it.name,
      address: it.address || '',
      city: it.city || '',
      cuisine: it.cuisine || '',
      url: it.url || '',
      lat: it.lat != null ? Number(it.lat) : null,
      lng: it.lng != null ? Number(it.lng) : null,
      place_id: it.place_id || null,
    }))
    : null;
  /** Last parse had zero issues and at least one row (or edit baseline before locations were edited). */
  let parseOk = !!isEdit;
  let slugBlocked = true;
  const initialNameTrim = initialName.trim();

  function updateSlugPreview() {
    const s = slugInput.value.trim();
    slugPreviewEl.textContent = s ? `Slug: list/${s}` : 'Slug: list/…';
  }

  const deleteBtn = newListBody.querySelector('#delete-list');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', () => {
      void handleDeleteList();
    });
  }

  csvTemplateDownloadBtn.addEventListener('click', () => {
    const blob = new Blob([CSV_TEMPLATE], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'list-import-template.csv';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
  });

  csvUploadTriggerBtn.addEventListener('click', () => csvFileInput.click());

  csvFileInput.addEventListener('change', async () => {
    const file = csvFileInput.files?.[0];
    csvFileInput.value = '';
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (e) {
      alert('Could not read that file: ' + (e?.message || String(e)));
      return;
    }
    const result = parsePayload(text, 'csv');
    if (!result.rows.length) {
      const hint = result.errors.length
        ? result.errors.slice(0, 8).join('\n')
        : 'No rows could be read from that CSV.';
      alert(hint);
      return;
    }
    itemsInput.value = parsedRowsToJsonTextareaValue(result.rows);
    runParse();
  });

  /** While true, list name length may exceed 32 without blocking Save (until blur). */
  let nameInputFocused = false;
  nameInput.addEventListener('focus', () => {
    nameInputFocused = true;
    if (listModalNameBlurTimer != null) {
      clearTimeout(listModalNameBlurTimer);
      listModalNameBlurTimer = null;
    }
    updatePrimaryButton();
  });
  nameInput.addEventListener('blur', () => {
    if (listModalNameBlurTimer != null) {
      clearTimeout(listModalNameBlurTimer);
      listModalNameBlurTimer = null;
    }
    listModalNameBlurTimer = setTimeout(() => {
      listModalNameBlurTimer = null;
      nameInputFocused = false;
      updatePrimaryButton();
    }, 0);
  });

  nameInput.addEventListener('input', () => {
    if (!isEdit) {
      slugInput.value = slugify(nameInput.value);
      updateSlugPreview();
    }
    validateSlug();
  });

  let slugCheckTimer = null;
  function validateSlug() {
    clearTimeout(slugCheckTimer);
    const value = slugInput.value.trim();
    if (!isValidSlug(value)) {
      slugBlocked = true;
      if (value.length === 0) {
        slugStatusEl.textContent = '';
        slugStatusEl.className = 'field-hint list-slug-status';
      } else {
        slugStatusEl.textContent = 'Use 2–32 letters, numbers, or hyphens.';
        slugStatusEl.className = 'field-hint list-slug-status err';
      }
      updatePrimaryButton();
      return;
    }
    if (RESERVED_SLUGS.has(value.toLowerCase())) {
      slugStatusEl.textContent = 'That slug is reserved.';
      slugStatusEl.className = 'field-hint list-slug-status err';
      slugBlocked = true;
      updatePrimaryButton();
      return;
    }
    if (isEdit && value === list.slug) {
      slugStatusEl.textContent = '';
      slugStatusEl.className = 'field-hint list-slug-status';
      slugBlocked = false;
      updatePrimaryButton();
      return;
    }
    slugStatusEl.textContent = 'Checking…';
    slugStatusEl.className = 'field-hint list-slug-status';
    slugBlocked = true;
    updatePrimaryButton();
    slugCheckTimer = setTimeout(async () => {
      const { data } = await supabase.from('lists').select('id').eq('slug', value).maybeSingle();
      if (slugInput.value.trim() !== value) return;
      if (data) {
        slugStatusEl.textContent = 'That slug is taken.';
        slugStatusEl.className = 'field-hint list-slug-status err';
        slugBlocked = true;
      } else {
        slugStatusEl.textContent = 'Available.';
        slugStatusEl.className = 'field-hint list-slug-status ok';
        slugBlocked = false;
      }
      updatePrimaryButton();
    }, 350);
  }

  function updatePrimaryButton() {
    const name = nameInput.value.trim();
    const nameOver32 = name.length > 32;
    const nameOk = name.length > 0 && (!nameOver32 || nameInputFocused);
    const hasLoc = itemsInput.value.trim().length > 0;
    const nameDirty = name !== initialNameTrim;
    const locationsDirty = itemsInput.value !== initialJson;
    const readyForSave = !!(hasLoc && parsedRows && parsedRows.length > 0 && parseOk);

    let mode = 'parse';
    if (!isEdit) {
      mode = readyForSave ? 'save' : 'parse';
    } else if (!locationsDirty) {
      mode = 'save';
    } else {
      mode = readyForSave ? 'save' : 'parse';
    }

    primaryBtn.dataset.mode = mode;
    primaryBtn.textContent = mode === 'parse' ? 'Parse' : (isEdit ? 'Save changes' : 'Save');

    let disabled = true;
    if (mode === 'parse') {
      disabled = !hasLoc;
    } else {
      if (!isEdit) {
        disabled = slugBlocked || !nameOk || !readyForSave;
      } else if (!nameDirty && !locationsDirty) {
        disabled = true;
      } else if (!locationsDirty && nameDirty) {
        disabled = slugBlocked || !nameOk;
      } else {
        disabled = slugBlocked || !nameOk || !readyForSave;
      }
    }
    primaryBtn.disabled = disabled;
  }

  function runParse() {
    const result = parsePayload(itemsInput.value, 'json');
    parsedRows = result.rows;
    parseOk = parsePayloadAllowsSave(result);
    renderSummary(result);
    updatePrimaryButton();
  }

  function renderSummary({ rows, errors }) {
    summary.hidden = false;
    const missing = rows.filter(r => r.lat == null || r.lng == null);
    summary.innerHTML = `
      <div class="summary-line"><strong>${rows.length}</strong> parsed${errors.length ? ', <span style="color:#c0392b">' + errors.length + ' issue' + (errors.length === 1 ? '' : 's') + '</span>' : ''}</div>
      ${errors.length ? `<details><summary>Show issues</summary><ul class="err-list">${errors.map(e => '<li>' + escapeHtml(e) + '</li>').join('')}</ul></details>` : ''}
      ${missing.length ? `<button type="button" class="modal-link-button" id="run-geocode">Geocode ${missing.length} missing coordinate${missing.length === 1 ? '' : 's'}</button>
        <div class="geocode-bar" id="geocode-bar" hidden><div class="geocode-bar-fill"></div></div>
        <div class="geocode-status" id="geocode-status" hidden></div>
        <div class="failed-rows" id="failed-rows" hidden></div>` : ''}
    `;
    if (missing.length) {
      const runBtn = summary.querySelector('#run-geocode');
      const bar = summary.querySelector('#geocode-bar');
      const fill = summary.querySelector('.geocode-bar-fill');
      const status = summary.querySelector('#geocode-status');
      const failedBox = summary.querySelector('#failed-rows');
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        bar.hidden = false;
        status.hidden = false;
        status.textContent = 'Looking up addresses (≈ 1 per second)…';
        const failed = await geocodeRows(parsedRows, (done, total) => {
          fill.style.width = Math.round((done / total) * 100) + '%';
          status.textContent = `Geocoded ${done} / ${total}…`;
        });
        status.textContent = failed.length
          ? `${missing.length - failed.length} matched, ${failed.length} not found.`
          : `Geocoded ${missing.length} addresses.`;
        if (failed.length) {
          failedBox.hidden = false;
          failedBox.innerHTML = failed.map(f => `
            <div class="failed-row" data-rank="${f.rank}">
              <span>#${f.rank}</span>
              <input type="text" value="${escapeHtml(f.query)}" aria-label="Address for rank ${f.rank}">
              <button type="button" data-retry-rank="${f.rank}">Retry</button>
            </div>
          `).join('');
          failedBox.querySelectorAll('button[data-retry-rank]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              const rank = Number(btn.dataset.retryRank);
              const row = failedBox.querySelector(`[data-rank="${rank}"]`);
              const input = row.querySelector('input');
              btn.disabled = true;
              btn.textContent = 'Retrying…';
              try {
                const result = await geocodeAddress(input.value);
                if (result) {
                  const target = parsedRows.find(r => r.rank === rank);
                  if (target) {
                    target.lat = result.lat;
                    target.lng = result.lng;
                    if (!target.address && input.value) target.address = input.value;
                  }
                  row.remove();
                  return;
                }
                btn.textContent = 'Not found';
              } catch (e) {
                btn.textContent = 'Error';
              }
              btn.disabled = false;
            });
          });
        }
        renderSummaryFooterMessage();
      });
    }
    updatePrimaryButton();
  }

  function renderSummaryFooterMessage() {
    const stillMissing = parsedRows.filter(r => r.lat == null || r.lng == null).length;
    const note = document.createElement('div');
    note.style.fontSize = '12px';
    note.style.color = 'var(--fg-dim)';
    note.style.marginTop = '6px';
    note.textContent = stillMissing
      ? `Saving anyway: ${stillMissing} row${stillMissing === 1 ? '' : 's'} without coordinates won’t appear on the map.`
      : 'All rows have coordinates.';
    summary.appendChild(note);
  }

  const placeCombobox = newListBody.querySelector('#place-search-combobox');
  const placeDropdown = newListBody.querySelector('#place-search-dropdown');
  const placeQ = newListBody.querySelector('#place-search-q');
  const placeStatus = newListBody.querySelector('#place-search-status');
  const placeUl = newListBody.querySelector('#place-search-results');

  function isListFormDirty() {
    const nameDirty = nameInput.value.trim() !== initialNameTrim;
    const locationsDirty = itemsInput.value !== initialJson;
    const slugDirty = slugInput.value.trim() !== initialSlugWhenOpened;
    const placeSearchDirty = (placeQ?.value || '').trim().length > 0;
    return nameDirty || locationsDirty || slugDirty || placeSearchDirty;
  }

  async function tryCloseListDialog() {
    if (!isListFormDirty()) {
      newListDialog.close('cancel');
      return;
    }
    const ok = await confirmDialog({
      message: 'You have unsaved changes in this list. Close without saving?',
      confirmLabel: 'Discard changes',
      cancelLabel: 'Keep editing',
    });
    if (ok) newListDialog.close('cancel');
  }

  cancelBtn.addEventListener('click', () => {
    void tryCloseListDialog();
  });

  listModalTryClose = tryCloseListDialog;

  let placeSearchGen = 0;
  let placeSearchDebounce = null;
  let placeHighlightIdx = -1;

  function syncPlaceDropdownPosition() {
    const r = placeCombobox.getBoundingClientRect();
    placeDropdown.style.position = 'fixed';
    placeDropdown.style.left = `${Math.round(r.left)}px`;
    placeDropdown.style.top = `${Math.round(r.bottom + 4)}px`;
    placeDropdown.style.width = `${Math.round(r.width)}px`;
  }

  function openPlaceDropdown() {
    placeDropdown.hidden = false;
    placeQ.setAttribute('aria-expanded', 'true');
    syncPlaceDropdownPosition();
  }

  function closePlaceDropdown() {
    placeDropdown.hidden = true;
    placeQ.setAttribute('aria-expanded', 'false');
    placeHighlightIdx = -1;
    placeUl.querySelectorAll('.place-result-option').forEach((b) => b.classList.remove('is-highlighted'));
    placeDropdown.style.position = '';
    placeDropdown.style.left = '';
    placeDropdown.style.top = '';
    placeDropdown.style.width = '';
  }

  function placeOptionButtons() {
    return [...placeUl.querySelectorAll('.place-result-option')];
  }

  function setPlaceHighlight(idx) {
    const opts = placeOptionButtons();
    if (!opts.length) return;
    placeHighlightIdx = Math.max(0, Math.min(idx, opts.length - 1));
    opts.forEach((b, i) => b.classList.toggle('is-highlighted', i === placeHighlightIdx));
    opts[placeHighlightIdx].scrollIntoView({ block: 'nearest' });
  }

  function movePlaceHighlight(delta) {
    const opts = placeOptionButtons();
    if (!opts.length || placeDropdown.hidden) return;
    const next = placeHighlightIdx < 0 ? (delta > 0 ? 0 : opts.length - 1) : placeHighlightIdx + delta;
    setPlaceHighlight(next);
  }

  function activateHighlightedPlace() {
    const opts = placeOptionButtons();
    if (placeHighlightIdx < 0 || placeHighlightIdx >= opts.length) return false;
    opts[placeHighlightIdx].click();
    return true;
  }

  newListPlaceSearchOutsideAbort?.abort();
  newListPlaceSearchOutsideAbort = new AbortController();
  newListDialog.addEventListener('mousedown', (e) => {
    if (placeCombobox.contains(e.target)) return;
    if (!placeDropdown.hidden) closePlaceDropdown();
  }, { signal: newListPlaceSearchOutsideAbort.signal });

  const syncDropdownOnWin = () => {
    if (!placeDropdown.hidden) syncPlaceDropdownPosition();
  };
  window.addEventListener('resize', syncDropdownOnWin, { signal: newListPlaceSearchOutsideAbort.signal });
  newListBody.addEventListener('scroll', () => closePlaceDropdown(), { signal: newListPlaceSearchOutsideAbort.signal });

  async function appendPlaceFromResult(p, li) {
    const probe = parsePayload(itemsInput.value, 'json');
    if (probe.rows.length >= LIST_ITEM_CAP) {
      openPlaceDropdown();
      placeStatus.hidden = false;
      placeStatus.className = 'place-search-dropdown-status err';
      placeStatus.textContent = `List is full (${LIST_ITEM_CAP} max).`;
      return;
    }
    const optBtn = li?.querySelector('.place-result-option');
    if (optBtn) optBtn.disabled = true;
    openPlaceDropdown();
    placeStatus.hidden = false;
    placeStatus.className = 'place-search-dropdown-status';
    try {
      let row;
      if (p.directRow) {
        placeStatus.textContent = 'Adding…';
        row = {
          rank: 0,
          name: p.directRow.name,
          address: p.directRow.address || '',
          city: p.directRow.city || '',
          cuisine: p.directRow.cuisine || '',
          url: p.directRow.url || '',
          lat: p.directRow.lat != null ? Number(p.directRow.lat) : null,
          lng: p.directRow.lng != null ? Number(p.directRow.lng) : null,
          place_id: p.directRow.place_id || null,
        };
      } else {
        placeStatus.textContent = 'Loading details…';
        row = await resolvePlaceRow(p.id, getGooglePlacesApiKey());
      }
      const newKey = locationIdentityKey(row);
      for (const existing of probe.rows) {
        if (locationIdentityKey(existing) === newKey) {
          placeStatus.hidden = false;
          placeStatus.className = 'place-search-dropdown-status';
          placeStatus.textContent = 'That location is already on this list.';
          return;
        }
      }
      appendRowToLocationsTextarea(itemsInput, row);
      const result = parsePayload(itemsInput.value, 'json');
      parsedRows = result.rows;
      parseOk = parsePayloadAllowsSave(result);
      summary.hidden = false;
      renderSummary(result);
      updatePrimaryButton();
      closePlaceDropdown();
      placeStatus.hidden = true;
      placeStatus.textContent = '';
    } catch (err) {
      placeStatus.className = 'place-search-dropdown-status err';
      placeStatus.textContent = String(err.message || err);
    } finally {
      if (optBtn) optBtn.disabled = false;
    }
  }

  /** Shown under list/cache (or Google) hits so users can still run Text Search. */
  function appendOptionalGoogleSearchFooter(query) {
    const qt = (query || '').trim();
    if (!qt || !getGooglePlacesApiKey()) return;
    const liFoot = document.createElement('li');
    liFoot.className = 'place-search-result-item place-search-results-google-footer';
    liFoot.setAttribute('role', 'presentation');
    const row = document.createElement('div');
    row.className = 'place-search-no-match-line place-search-google-footer-line';
    const prefix = document.createElement('span');
    prefix.className = 'place-search-no-match-prefix';
    prefix.textContent = 'Not the right place?';
    row.appendChild(prefix);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'place-result-option place-search-google-option place-search-google-option--inline';
    btn.setAttribute('role', 'option');
    btn.innerHTML = '<span class="place-search-google-label">Search Google</span>';
    btn.addEventListener('click', () => runGooglePlaceSearch(qt));
    row.appendChild(btn);
    liFoot.appendChild(row);
    placeUl.appendChild(liFoot);
  }

  function appendPlaceResultRowEl(p) {
    const li = document.createElement('li');
    li.className = 'place-search-result-item';
    li.setAttribute('role', 'presentation');
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'place-result-option';
    opt.setAttribute('role', 'option');
    const title = escapeHtml(p.displayName?.text || barePlaceId(p.id));
    const sub = escapeHtml(p.formattedAddress || '');
    const badge = p.source === 'saved' ? '<span class="place-result-badge">Saved</span>' : '';
    opt.innerHTML = `<span class="place-result-name">${title}</span>${badge}<span class="place-result-meta">${sub}</span>`;
    opt.addEventListener('click', () => appendPlaceFromResult(p, li));
    li.appendChild(opt);
    placeUl.appendChild(li);
  }

  function renderPlaceResultRows(places, q, hasGoogleKey, savedError, googleError, listItemsError, options = {}) {
    const statusHint = options.statusHint || null;
    placeUl.innerHTML = '';
    placeHighlightIdx = -1;
    if (!places.length) {
      if (!q) {
        placeUl.hidden = true;
        placeStatus.textContent = '';
        placeStatus.hidden = true;
        closePlaceDropdown();
        return;
      }
      openPlaceDropdown();

      const parts = [];
      if (listItemsError) parts.push(`Lists: ${listItemsError}`);
      if (savedError) parts.push(`Place cache: ${savedError}`);
      if (googleError) parts.push(`Google: ${googleError}`);
      const hasErrors = parts.length > 0;
      placeStatus.className = 'place-search-dropdown-status' + (hasErrors ? ' err' : '');

      if (hasErrors) {
        placeStatus.hidden = false;
        placeStatus.textContent = parts.join(' · ');
      } else if (statusHint) {
        placeStatus.hidden = false;
        placeStatus.textContent = statusHint;
      } else {
        placeStatus.textContent = '';
        placeStatus.hidden = true;
      }

      if (q.trim()) {
        placeUl.hidden = false;
        const li = document.createElement('li');
        li.className = 'place-search-result-item';
        li.setAttribute('role', 'presentation');
        if (!hasErrors && !statusHint) {
          const row = document.createElement('div');
          row.className = 'place-search-no-match-line';
          const prefix = document.createElement('span');
          prefix.className = 'place-search-no-match-prefix';
          prefix.textContent = 'No match.';
          row.appendChild(prefix);
          if (hasGoogleKey) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'place-result-option place-search-google-option place-search-google-option--inline';
            btn.setAttribute('role', 'option');
            btn.innerHTML = '<span class="place-search-google-label">Search Google</span>';
            btn.addEventListener('click', () => runGooglePlaceSearch(q));
            row.appendChild(btn);
          } else {
            const hint = document.createElement('span');
            hint.className = 'place-search-no-match-key-hint';
            hint.innerHTML =
              'Add your Places API key to search Google. Use <code>npm run dev</code> with '
              + '<code>.env</code> <code>GOOGLE_PLACES_API_KEY</code>, deploy inject, or '
              + '<code>config.local.js</code> from <code>config.local.example.js</code>.';
            row.appendChild(hint);
          }
          li.appendChild(row);
        } else if (hasGoogleKey) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'place-result-option place-search-google-option';
          btn.setAttribute('role', 'option');
          btn.innerHTML = '<span class="place-search-google-label">Search Google</span>';
          btn.addEventListener('click', () => runGooglePlaceSearch(q));
          li.appendChild(btn);
        } else {
          const wrap = document.createElement('div');
          wrap.className = 'place-search-google-locked';
          wrap.setAttribute('role', 'note');
          wrap.innerHTML =
            '<span class="place-search-google-locked-title">Search Google</span>'
            + '<span class="place-result-meta">The page has no key in the meta tag yet. '
            + 'Use <code>npm run dev</code> (with <code>.env</code> <code>GOOGLE_PLACES_API_KEY</code>), deploy with CI inject, '
            + 'or copy <code>config.local.example.js</code> to <code>config.local.js</code> and set '
            + '<code>window.__TOP100_GOOGLE_PLACES_KEY__</code>, then hard-refresh.</span>';
          li.appendChild(wrap);
        }
        placeUl.appendChild(li);
        openPlaceDropdown();
      } else {
        placeUl.hidden = true;
      }
      return;
    }
    placeStatus.hidden = true;
    placeStatus.textContent = '';
    placeUl.hidden = false;
    openPlaceDropdown();
    for (const p of places) appendPlaceResultRowEl(p);
    if (hasGoogleKey) appendOptionalGoogleSearchFooter(q);
  }

  async function runGooglePlaceSearch(q) {
    const genAtClick = placeSearchGen;
    const query = (q || '').trim();
    if (!query) return;
    if (!getGooglePlacesApiKey()) {
      placeStatus.hidden = false;
      placeStatus.className = 'place-search-dropdown-status err';
      placeStatus.textContent = 'No Google Places API key on this page.';
      return;
    }
    openPlaceDropdown();
    placeStatus.hidden = false;
    placeStatus.className = 'place-search-dropdown-status';
    placeStatus.textContent = 'Searching Google…';
    placeUl.hidden = true;
    placeUl.innerHTML = '';
    const { places: gPlaces, googleError } = await searchGooglePlacesForPicker(query);
    if (genAtClick !== placeSearchGen) return;
    if (googleError) {
      renderPlaceResultRows([], query, true, null, googleError, null, {});
      return;
    }
    if (!gPlaces.length) {
      renderPlaceResultRows([], query, true, null, null, null, {
        statusHint: 'Google returned no results for that search.',
      });
      return;
    }
    placeStatus.hidden = true;
    placeStatus.textContent = '';
    placeUl.hidden = false;
    placeUl.innerHTML = '';
    placeHighlightIdx = -1;
    openPlaceDropdown();
    for (const p of gPlaces) appendPlaceResultRowEl(p);
    appendOptionalGoogleSearchFooter(query);
    syncPlaceDropdownPosition();
  }

  async function runPlaceSearch(q) {
    const gen = ++placeSearchGen;
    if (!q) {
      placeUl.innerHTML = '';
      placeUl.hidden = true;
      placeStatus.textContent = '';
      placeStatus.hidden = true;
      closePlaceDropdown();
      return;
    }
    openPlaceDropdown();
    placeStatus.hidden = false;
    placeStatus.className = 'place-search-dropdown-status';
    placeStatus.textContent = 'Searching…';
    placeUl.hidden = true;
    placeUl.innerHTML = '';
    try {
      const { places, hasGoogleKey, savedError, listItemsError } = await searchPlacesCombined(q);
      if (gen !== placeSearchGen) return;
      renderPlaceResultRows(places, q, hasGoogleKey, savedError, null, listItemsError, {});
    } catch (e) {
      if (gen !== placeSearchGen) return;
      openPlaceDropdown();
      placeStatus.hidden = false;
      placeStatus.className = 'place-search-dropdown-status err';
      placeStatus.textContent = String(e.message || e);
      placeUl.hidden = true;
      placeUl.innerHTML = '';
    }
  }

  placeQ?.addEventListener('input', () => {
    clearTimeout(placeSearchDebounce);
    const q = (placeQ.value || '').trim();
    placeSearchDebounce = setTimeout(() => runPlaceSearch(q), 320);
  });

  placeQ?.addEventListener('keydown', (ev) => {
    const q = (placeQ.value || '').trim();
    if (ev.key === 'Escape') {
      ev.preventDefault();
      closePlaceDropdown();
      return;
    }
    if (ev.key === 'ArrowDown') {
      if (!placeDropdown.hidden && placeOptionButtons().length) {
        ev.preventDefault();
        movePlaceHighlight(1);
      }
      return;
    }
    if (ev.key === 'ArrowUp') {
      if (!placeDropdown.hidden && placeOptionButtons().length) {
        ev.preventDefault();
        movePlaceHighlight(-1);
      }
      return;
    }
    if (ev.key === 'Enter') {
      if (!placeDropdown.hidden && activateHighlightedPlace()) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      clearTimeout(placeSearchDebounce);
      runPlaceSearch(q);
    }
  });

  primaryBtn.addEventListener('click', (ev) => {
    if (primaryBtn.disabled) return;
    if (primaryBtn.dataset.mode === 'parse') runParse();
    else handleSave(ev);
  });

  // Any edit to the locations textarea invalidates parsed rows until Parse,
  // except when the text matches the original edit payload again.
  itemsInput.addEventListener('input', () => {
    const locationsDirtyNow = itemsInput.value !== initialJson;
    if (!locationsDirtyNow && isEdit) {
      parsedRows = items.map((it, i) => ({
        rank: i + 1,
        name: it.name,
        address: it.address || '',
        city: it.city || '',
        cuisine: it.cuisine || '',
        url: it.url || '',
        lat: it.lat != null ? Number(it.lat) : null,
        lng: it.lng != null ? Number(it.lng) : null,
        place_id: it.place_id || null,
      }));
      parseOk = true;
      summary.hidden = false;
      renderSummary({ rows: parsedRows, errors: [] });
    } else {
      parsedRows = null;
      parseOk = false;
      summary.innerHTML = '';
      summary.hidden = true;
    }
    updatePrimaryButton();
  });

  if (isEdit) {
    parsedRows.forEach((r, i) => { r.rank = i + 1; });
    renderSummary({ rows: parsedRows, errors: [] });
  }

  updateSlugPreview();
  validateSlug();
  updatePrimaryButton();

  const handleSave = async (e) => {
    if (e) e.preventDefault();
    if (primaryBtn.disabled || primaryBtn.dataset.mode !== 'save') return;
    const name = nameInput.value.trim();
    const slug = slugInput.value.trim();
    if (!name || name.length > 32 || !isValidSlug(slug)) {
      alert('Please enter a name (up to 32 characters) and valid slug.');
      return;
    }
    if (!parsedRows || !parsedRows.length) {
      alert('Parse the list data before saving.');
      return;
    }

    primaryBtn.disabled = true;
    primaryBtn.textContent = 'Saving…';
    const showError = (msg) => {
      summary.hidden = false;
      summary.innerHTML = `<div class="summary-line" style="color:#c0392b">Save failed: ${escapeHtml(String(msg))}</div>`;
      primaryBtn.disabled = false;
      updatePrimaryButton();
    };
    try {
      if (isEdit) {
        const { error: updateErr } = await supabase
          .from('lists')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', list.id);
        if (updateErr) throw updateErr;
        const { error: rpcErr } = await supabase.rpc('replace_list_items', {
          p_list_id: list.id,
          p_items: parsedRows.map((r, i) => ({ ...r, rank: i + 1 })),
        });
        if (rpcErr) throw rpcErr;
        newListDialog.close('save');
        history.pushState({}, '', '/list/' + slug);
        await applyRoute(parseRoute());
      } else {
        const countRes = await supabase
          .from('lists')
          .select('id', { count: 'exact', head: true })
          .eq('owner_id', currentUser.id)
          .is('deleted_at', null);
        if (countRes.error) throw countRes.error;
        if ((countRes.count ?? 0) >= LIST_PER_USER_CAP) {
          throw new Error(`You already have ${LIST_PER_USER_CAP} lists. Delete one first.`);
        }
        const insertRes = await supabase
          .from('lists')
          .insert({ owner_id: currentUser.id, slug, name })
          .select('id, slug, name, owner_id, deleted_at')
          .single();
        if (insertRes.error) throw insertRes.error;
        const newList = insertRes.data;
        const itemRows = parsedRows.map((r, i) => ({
          list_id: newList.id,
          rank: i + 1,
          name: r.name,
          address: r.address || null,
          city: r.city || null,
          cuisine: r.cuisine || null,
          url: r.url || null,
          lat: r.lat,
          lng: r.lng,
          place_id: r.place_id || null,
        }));
        const { error: itemsErr } = await supabase.from('list_items').insert(itemRows);
        if (itemsErr) throw itemsErr;
        newListDialog.close('save');
        history.pushState({}, '', '/list/' + slug);
        await applyRoute(parseRoute());
      }
    } catch (err) {
      console.error('save list failed', err);
      showError(err?.message || err?.details || err?.hint || err?.code || 'unknown error');
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (primaryBtn.disabled) return;
    if (primaryBtn.dataset.mode === 'parse') runParse();
    else handleSave(e);
  });
}

// ---------------------------------------------------------------------------
// All-lists directory (Phase 6)
//
// Shows up to 200 active lists with item count and per-user visit progress.
// Sorted by aggregate visits (all users): each distinct (user_id, list venue
// name_key) with a matching visited row counts once. Not shown in the UI.
// When the viewer is signed in, also shows their own progress per list.
// ---------------------------------------------------------------------------
const allListsDialog = document.getElementById('all-lists-dialog');
const allListsBody = document.getElementById('all-lists-body');

allListsDialog.addEventListener('click', (e) => {
  if (e.target === allListsDialog) allListsDialog.close('cancel');
});

async function openAllListsDialog() {
  allListsBody.innerHTML = `
    <div class="all-lists-header">
      <h2 class="modal-title" id="all-lists-title">All lists</h2>
      <button type="button" class="modal-close-btn" id="all-lists-close" aria-label="Close">×</button>
    </div>
    <input type="search" id="all-lists-search" class="all-lists-search" placeholder="Search lists…" autocomplete="off" spellcheck="false">
    <div class="all-lists-loading">Loading…</div>
  `;
  allListsDialog.showModal();
  allListsBody.querySelector('#all-lists-close')?.addEventListener('click', () => {
    allListsDialog.close('cancel');
  });
  const searchInput = allListsBody.querySelector('#all-lists-search');

  // Grid is created once the data arrives. Wire the search input up front so
  // keystrokes during the async load aren't lost — applyFilter just no-ops
  // until rows exist, then a final call after render catches any pre-typed
  // query.
  let grid = null;
  let emptyMsg = null;
  const applyFilter = () => {
    if (!grid) return;
    const q = (searchInput?.value || '').trim().toLowerCase();
    let visible = 0;
    for (const row of grid.querySelectorAll('.all-lists-row')) {
      const match = !q || row.dataset.search.includes(q);
      row.hidden = !match;
      if (match) visible += 1;
    }
    if (!visible && q) {
      if (!emptyMsg) {
        emptyMsg = document.createElement('div');
        emptyMsg.className = 'all-lists-empty';
        grid.after(emptyMsg);
      }
      emptyMsg.textContent = `No lists match "${q}".`;
      emptyMsg.hidden = false;
    } else if (emptyMsg) {
      emptyMsg.hidden = true;
    }
  };
  if (searchInput) {
    searchInput.addEventListener('input', applyFilter);
    searchInput.focus();
  }

  try {
    const [listsRes, progressRes, visitTotalsRes] = await Promise.all([
      supabase
        .from('lists')
        .select('id, slug, name, owner_id')
        .is('deleted_at', null)
        .limit(200),
      currentUser
        ? fetchProgressRowsByName('visited', currentUser.id)
        : Promise.resolve({ data: [], error: null }),
      supabase.rpc('get_list_visit_totals'),
    ]);

    let countsRes = await supabase
      .from('list_items')
      .select('list_id, rank, name, name_key');
    if (countsRes.error && isMissingListItemsColumnError(countsRes.error)) {
      countsRes = await supabase.from('list_items').select('list_id, rank, name');
    }

    if (listsRes.error) console.warn('all-lists: lists query failed; continuing with default only', listsRes.error.message || listsRes.error);

    const lists = (listsRes.data || []).map(withCanonicalDefaultListName);
    const visitTotals = new Map();
    if (visitTotalsRes.error) {
      console.warn('all-lists: get_list_visit_totals failed (sort falls back to name)', visitTotalsRes.error.message || visitTotalsRes.error);
    } else {
      for (const row of visitTotalsRes.data || []) {
        if (row?.list_id != null) {
          visitTotals.set(row.list_id, Number(row.visit_count) || 0);
        }
      }
    }
    const ownerIds = [...new Set(lists.map(l => l.owner_id))];
    const profilesByUid = new Map();
    if (ownerIds.length) {
      const profilesRes = await supabase
        .from('profiles')
        .select('user_id, username')
        .in('user_id', ownerIds);
      if (!profilesRes.error) {
        for (const p of profilesRes.data || []) profilesByUid.set(p.user_id, p.username);
      }
    }

    const counts = new Map();
    /** @type {Map<string, Array<{ name: string, name_key: string | null }>>} */
    const namesByList = new Map();
    /** @type {Map<string, Map<number, string>>} list_id -> rank -> normalized name key */
    const rankNameByList = new Map();
    if (!countsRes.error) {
      for (const row of countsRes.data || []) {
        counts.set(row.list_id, (counts.get(row.list_id) || 0) + 1);
        if (row.name) {
          const nk = row.name_key != null && String(row.name_key).trim() !== ''
            ? String(row.name_key).trim()
            : null;
          const entry = { name: row.name, name_key: nk };
          const bucket = namesByList.get(row.list_id);
          if (bucket) bucket.push(entry);
          else namesByList.set(row.list_id, [entry]);
        }
        if (row.rank != null && row.name) {
          if (!rankNameByList.has(row.list_id)) rankNameByList.set(row.list_id, new Map());
          const rk =
            row.name_key != null && String(row.name_key).trim() !== ''
              ? String(row.name_key).trim()
              : progressKey(row.name);
          rankNameByList.get(row.list_id).set(row.rank, rk);
        }
      }
    }
    // Build a Set of the signed-in user's globally-visited name keys, then
    // intersect against each list's items to compute per-list progress.
    const visitedKeys = new Set();
    if (currentUser && !progressRes.error) {
      for (const k of keysFromProgressRows(progressRes.data || [])) visitedKeys.add(k);
    } else if (currentUser && progressRes.error && isMissingProgressColumnError(progressRes.error)) {
      const leg = await supabase.from('visited').select('list_id,rank').eq('user_id', currentUser.id);
      if (!leg.error) {
        for (const row of leg.data || []) {
          const m = rankNameByList.get(row.list_id);
          const nk = m?.get(row.rank);
          if (nk) visitedKeys.add(nk);
        }
      }
    }
    const progress = new Map();
    for (const [listId, rows] of namesByList) {
      let count = 0;
      for (const e of rows) {
        if (progressSetHas(visitedKeys, e.name, e.name_key)) count++;
      }
      if (count) progress.set(listId, count);
    }

    // Ensure the site-wide default list is always represented, even if it
    // hasn't been seeded into the `lists` table yet.
    let syntheticDefaultPlatformVisits = 0;
    if (!lists.some(l => l.slug === DEFAULT_LIST_SLUG)) {
      lists.unshift({
        id: null,
        slug: DEFAULT_LIST_SLUG,
        name: DEFAULT_LIST_NAME,
        owner_id: null,
      });
      const keys = DEFAULT_RESTAURANTS.map((r) =>
        r.name_key != null && String(r.name_key).trim() !== ''
          ? String(r.name_key).trim()
          : progressKey(r.name),
      );
      const vr = await supabase.rpc('visit_count_for_name_keys', { p_name_keys: keys });
      if (vr.error) {
        console.warn(
          'all-lists: visit_count_for_name_keys failed; default list sorts as 0 visits',
          vr.error.message || vr.error,
        );
      } else {
        syntheticDefaultPlatformVisits = Number(vr.data) || 0;
      }
    }

    /** Platform-wide list popularity for sort (not the signed-in user's x/y). */
    function allUsersVisitTotal(list) {
      if (list?.id != null) return visitTotals.get(list.id) || 0;
      if (list?.slug === DEFAULT_LIST_SLUG && list.id == null) return syntheticDefaultPlatformVisits;
      return 0;
    }
    // Highest get_list_visit_totals first; tie-break by name. Personal progress
    // (myProgress) is only shown in each row, never used for ordering.
    lists.sort((a, b) => {
      const d = allUsersVisitTotal(b) - allUsersVisitTotal(a);
      if (d !== 0) return d;
      return String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' });
    });

    if (!lists.length) {
      allListsBody.querySelector('.all-lists-loading').outerHTML = '<div class="all-lists-empty">No lists yet — create the first one from the menu.</div>';
      return;
    }

    grid = document.createElement('div');
    grid.className = 'all-lists-grid';
    for (const list of lists) {
      const isDefault = list.slug === DEFAULT_LIST_SLUG;
      const ownerUsername = isDefault
        ? DEFAULT_LIST_OWNER_USERNAME
        : (profilesByUid.get(list.owner_id) || null);
      const itemCount = isDefault
        ? (counts.get(list.id) || DEFAULT_RESTAURANTS.length)
        : (counts.get(list.id) || 0);
      let myProgress = progress.get(list.id) || 0;
      // When the default list isn't seeded in list_items yet, intersect the
      // user's globally-visited name keys against DEFAULT_RESTAURANTS so the
      // count still reflects reality.
      if (isDefault && !counts.get(list.id) && visitedKeys.size) {
        myProgress = DEFAULT_RESTAURANTS.reduce(
          (n, r) => n + (progressSetHas(visitedKeys, r.name, r.name_key) ? 1 : 0),
          0,
        );
      }
      const href = isDefault ? '/' : `/list/${list.slug}`;
      const a = document.createElement('a');
      a.className = 'all-lists-row';
      a.href = href;
      a.innerHTML = `
        <div class="all-lists-name">${escapeHtml(list.name)}</div>
        <div class="all-lists-progress${myProgress > 0 ? ' has-progress' : ''}">${myProgress}/${itemCount} visited</div>
      `;
      const itemNames = (namesByList.get(list.id) || []).map(e => e.name);
      const fallbackNames = isDefault && !itemNames.length
        ? DEFAULT_RESTAURANTS.map(r => r.name)
        : [];
      a.dataset.search = `${list.name} ${ownerUsername || ''} ${itemNames.join(' ')} ${fallbackNames.join(' ')}`.toLowerCase();
      a.addEventListener('click', (e) => {
        e.preventDefault();
        const targetHref = href;
        allListsDialog.close('navigate');
        // Wait until the modal top layer is gone and layout has settled; otherwise
        // the list/map can paint with wrong geometry until the user interacts.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            history.pushState({}, '', targetHref);
            void applyRoute(parseRoute());
          });
        });
      });
      grid.appendChild(a);
    }
    const loading = allListsBody.querySelector('.all-lists-loading');
    loading.replaceWith(grid);

    let gridScrollTimer;
    grid.addEventListener('scroll', () => {
      grid.classList.add('is-scrolling');
      clearTimeout(gridScrollTimer);
      gridScrollTimer = setTimeout(() => grid.classList.remove('is-scrolling'), 800);
    }, { passive: true });

    applyFilter();
  } catch (err) {
    console.error('all-lists load failed', err);
    allListsBody.querySelector('.all-lists-loading').outerHTML = `<div class="all-lists-empty">Could not load lists: ${escapeHtml(err.message || 'unknown error')}</div>`;
  }
}

const confirmDialogEl = document.getElementById('confirm-dialog');
const confirmDialogText = document.getElementById('confirm-dialog-text');
const confirmDialogConfirmBtn = confirmDialogEl.querySelector('.modal-confirm');
const confirmDialogCancelBtn = confirmDialogEl.querySelector('.modal-cancel');

confirmDialogEl.addEventListener('click', (e) => {
  if (e.target === confirmDialogEl) confirmDialogEl.close('cancel');
});

function confirmDialog({ message, confirmLabel = 'Confirm', cancelLabel = 'Cancel' } = {}) {
  confirmDialogText.textContent = message;
  confirmDialogConfirmBtn.textContent = confirmLabel;
  confirmDialogCancelBtn.textContent = cancelLabel;
  if (typeof confirmDialogEl.showModal === 'function') {
    confirmDialogEl.showModal();
  } else {
    return Promise.resolve(window.confirm(message));
  }
  return new Promise((resolve) => {
    confirmDialogEl.addEventListener('close', () => {
      resolve(confirmDialogEl.returnValue === 'confirm');
    }, { once: true });
  });
}

function renderAuthSignedOut() {
  authEl.innerHTML = `<button id="show-signin" aria-label="Sign in to sync"><span class="label-long">Sign in to sync</span><span class="label-short">Sign in</span></button>`;
  authEl.querySelector('#show-signin').addEventListener('click', renderAuthForm);
}

function renderAuthForm() {
  authEl.innerHTML = `
    <input id="email-input" type="email" placeholder="you@example.com" autocomplete="email">
    <button id="send-link" aria-label="Send magic link"><span class="label-long">Send magic link</span><span class="label-short">Send</span></button>
    <button id="cancel-signin">Cancel</button>
  `;
  const input = authEl.querySelector('#email-input');
  input.focus();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') sendMagicLink(); });
  authEl.querySelector('#send-link').addEventListener('click', sendMagicLink);
  authEl.querySelector('#cancel-signin').addEventListener('click', renderAuthSignedOut);
}

async function sendMagicLink() {
  const input = authEl.querySelector('#email-input');
  const btn = authEl.querySelector('#send-link');
  if (!input) return;
  const email = input.value.trim();
  if (!email) { input.focus(); return; }
  btn.disabled = true;
  btn.textContent = 'Sending…';
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname },
  });
  if (error) {
    authEl.innerHTML = `<span class="err"></span> <button id="retry">Retry</button>`;
    authEl.querySelector('.err').textContent = error.message;
    authEl.querySelector('#retry').addEventListener('click', renderAuthForm);
    return;
  }
  authEl.innerHTML = `<span class="msg"></span>`;
  authEl.querySelector('.msg').textContent = `Check ${email} for a sign-in link.`;
}

async function loadCurrentProfile() {
  if (!currentUser) { currentProfile = null; return; }
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, username')
    .eq('user_id', currentUser.id)
    .maybeSingle();
  if (error) {
    console.warn('profile lookup failed', error.message);
    currentProfile = null;
    return;
  }
  currentProfile = data || null;
}

// Generates a placeholder username like "user7k3m9ab2" so new accounts show
// up in /directory listings instead of "unknown owner". Users can rename it
// from the hamburger menu at any time. 8 base-36 chars ≈ 2.8e12 possibilities,
// and we still retry on unique-constraint conflicts.
function generateRandomUsername() {
  const suffix = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return 'user' + suffix;
}

async function ensureProfileUsername() {
  if (!currentUser || currentProfile) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    const username = generateRandomUsername();
    if (RESERVED_SLUGS.has(username)) continue;
    const { data, error } = await supabase
      .from('profiles')
      .insert({ user_id: currentUser.id, username })
      .select('user_id, username')
      .maybeSingle();
    if (!error && data) {
      currentProfile = data;
      return;
    }
    if (error && error.code === '23505') {
      // Either user_id collision (another tab / request already inserted a
      // row) or username collision. Re-load — if a row exists now, we're
      // done; otherwise loop and try a new random suffix.
      await loadCurrentProfile();
      if (currentProfile) return;
      continue;
    }
    console.warn('auto-username failed', error?.message || error);
    return;
  }
  console.warn('auto-username: exhausted retries');
}

async function onSignIn(user) {
  currentUser = user;
  await loadCurrentProfile();
  if (!currentProfile) await ensureProfileUsername();
  renderAuthSignedIn();
  try {
    const shareRes = await supabase
      .from('public_lists')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();
    sharingEnabled = !shareRes.error && !!shareRes.data;
  } catch (e) {
    console.warn('sharing status check failed', e);
  }
  await loadOverlay();
}

async function onSignOut() {
  currentUser = null;
  currentProfile = null;
  sharingEnabled = false;
  if (!viewingUserId && shouldUseLocalStorage()) {
    localStorage.removeItem(STORAGE_KEY_VISITED);
    localStorage.removeItem(STORAGE_KEY_HEARTED);
    localStorage.removeItem(LEGACY_STORAGE_VISITED);
    localStorage.removeItem(LEGACY_STORAGE_HEARTED);
  }
  clearLocalState();
  renderAuthSignedOut();
}

// ---------------------------------------------------------------------------
// Back-compat: convert legacy ?u=<uuid> (and optional ?list=<slug>) into a
// pretty URL when the target user has a username; otherwise leave the query
// in place and resolve via the legacy public_lists table.
// ---------------------------------------------------------------------------
// Returns true when the legacy path fully rendered the page and boot()
// should skip the subsequent applyRoute() call (which would otherwise
// clobber the overlay we just mounted, because the URL still has
// `?u=&list=` and parseRoute would resolve that to the default list).
// Returns false when we either didn't match a legacy URL or we rewrote
// history to a pretty URL that applyRoute can re-parse cleanly.
async function resolveLegacyShareLink() {
  const params = new URLSearchParams(window.location.search);
  const uid = params.get('u');
  if (!uid || !UUID_RE.test(uid)) return false;

  const slug = params.get('list');
  let usernameRes;
  try {
    usernameRes = await supabase
      .from('profiles')
      .select('username')
      .eq('user_id', uid)
      .maybeSingle();
  } catch (e) {
    console.warn('legacy share lookup failed', e);
    return false;
  }
  if (usernameRes.error || !usernameRes.data) {
    // No username yet -- honor ?list=<slug> if present so non-owner shares
    // of non-default lists still resolve. Render here and tell boot() to
    // skip applyRoute.
    await mountLegacyOverlay(uid, slug);
    return true;
  }
  const username = usernameRes.data.username;
  const newPath = slug ? `/${username}/${slug}` : `/${username}`;
  history.replaceState({}, '', newPath);
  route = parseRoute();
  return false;
}

async function mountLegacyOverlay(uid, slug) {
  // Used when ?u=<uuid> resolves to a user without a profiles row. Mirrors
  // the old enterViewingMode() behaviour: read public_lists for a display
  // name, then load that user's visited/hearted on the requested list (or
  // the default list when no ?list= slug was provided).
  let list;
  try {
    list = await fetchListBySlug(slug || DEFAULT_LIST_SLUG);
  } catch (err) {
    console.warn('legacy share slug not found; falling back to default', slug, err?.message || err);
    list = await fetchListBySlug(DEFAULT_LIST_SLUG);
  }
  listMeta = list;
  setRestaurants(await fetchListItems(list.id).then(items => items.length ? items : DEFAULT_RESTAURANTS));
  viewingUserId = uid;
  const { data } = await supabase
    .from('public_lists')
    .select('display')
    .eq('user_id', uid)
    .maybeSingle();
  viewingProfile = data ? { user_id: uid, username: data.display } : null;
  await loadOverlay();
  renderViewBanner();
  document.title = isDefaultList()
    ? `Top100SF — ${DEFAULT_LIST_NAME}`
    : `${listMeta.name} · Top100SF`;
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
window.addEventListener('popstate', () => {
  applyRoute(parseRoute());
});

renderAuthSignedOut();

(async function boot() {
  const legacyMounted = await resolveLegacyShareLink();
  if (!legacyMounted) await applyRoute(parseRoute());
  setTimeout(showVisitedHint, 400);
})();

supabase.auth.onAuthStateChange((event, session) => {
  const user = session?.user || null;
  if (user && (!currentUser || currentUser.id !== user.id)) {
    onSignIn(user);
  } else if (!user && currentUser) {
    onSignOut();
  }
});
