#!/usr/bin/env python3
"""
Resolve Google Place IDs for rows in public.list_items where place_id is null
or blank, then update Postgres via `supabase db query --linked` (no service
role key needed when the Supabase CLI is logged in and linked to the project).

Also upserts public.places so the app cache is warm.

Requires:
  - GOOGLE_MAPS_API_KEY (Places API: Find Place From Text + Place Details)
  - supabase CLI on PATH, project linked (`supabase link`)
  - Network

Env:
  SUPABASE_URL          default: same publishable host as app.js
  SUPABASE_ANON_KEY     default: publishable key from app.js (read-only REST)
  GOOGLE_MAPS_API_KEY   required unless GOOGLE_MAPS_API_KEY_FILE points to a file

Usage:
  GOOGLE_MAPS_API_KEY=... python3 scripts/backfill_supabase_place_ids.py
  GOOGLE_MAPS_API_KEY=... python3 scripts/backfill_supabase_place_ids.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

DEFAULT_SUPABASE_URL = "https://goeehdtfgzscyaazbewb.supabase.co"
DEFAULT_SUPABASE_ANON_KEY = "sb_publishable_EgEDBzERdk7DQK5fXk9fjQ_o_viqH0e"


def _tokens(s: str) -> set[str]:
    s = re.sub(r"[^a-z0-9]+", " ", s.lower())
    return {w for w in s.split() if len(w) >= 3}


def _name_plausible(place_name: str, want_name: str) -> bool:
    if not place_name or not want_name:
        return False
    a = _tokens(want_name)
    b = _tokens(place_name)
    if not a:
        return want_name.lower() in place_name.lower()
    if a & b:
        return True
    wl = want_name.lower()
    pl = place_name.lower()
    return wl in pl or pl in wl


def _http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "top100-place-backfill/1.0"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.load(r)


def _google_key() -> str:
    k = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
    if k:
        return k
    path = os.environ.get("GOOGLE_MAPS_API_KEY_FILE", "").strip()
    if path:
        return Path(path).read_text().strip()
    return ""


def _find_place_id(
    key: str, name: str, address: str | None, city: str | None, lat: float | None, lng: float | None
) -> tuple[str | None, str | None]:
    parts = [p for p in (name, address, city) if p and str(p).strip()]
    if not parts:
        return None, None
    query = ", ".join(parts)
    params: dict[str, str] = {
        "input": query,
        "inputtype": "textquery",
        "fields": "place_id,name",
        "key": key,
    }
    if lat is not None and lng is not None:
        params["locationbias"] = f"point:{lat},{lng}"
    url = "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?" + urllib.parse.urlencode(
        params
    )
    j = _http_json(url)
    st = j.get("status")
    if st in ("REQUEST_DENIED", "INVALID_REQUEST"):
        raise RuntimeError(f"findplacefromtext {st}: {j.get('error_message')}")
    if st not in ("OK", "ZERO_RESULTS"):
        raise RuntimeError(f"findplacefromtext {st}: {j.get('error_message')}")
    cands = j.get("candidates") or []
    if not cands:
        return None, None
    pid = cands[0].get("place_id")
    pname = cands[0].get("name") or ""
    if not pid or not _name_plausible(pname, name):
        return None, pname or None
    return str(pid), pname


def _place_details(key: str, place_id: str) -> dict:
    params = {
        "place_id": place_id,
        "fields": "name,formatted_address,address_components,geometry,website,types",
        "key": key,
    }
    url = "https://maps.googleapis.com/maps/api/place/details/json?" + urllib.parse.urlencode(params)
    j = _http_json(url)
    st = j.get("status")
    if st in ("REQUEST_DENIED", "INVALID_REQUEST"):
        raise RuntimeError(f"details {st}: {j.get('error_message')}")
    if st != "OK":
        raise RuntimeError(f"details {st}: {j.get('error_message')}")
    return j.get("result") or {}


def _pick_locality(comps: list) -> str:
    want = ("locality", "sublocality_level_1", "postal_town", "neighborhood")
    for w in want:
        for c in comps or []:
            types = c.get("types") or []
            if w in types:
                return (c.get("long_name") or c.get("short_name") or "").strip()
    return ""


def _pick_route_line(comps: list) -> str:
    route = ""
    street_num = ""
    for c in comps or []:
        t = c.get("types") or []
        if "route" in t:
            route = (c.get("long_name") or "").strip()
        if "street_number" in t:
            street_num = (c.get("long_name") or "").strip()
    line = " ".join(x for x in (street_num, route) if x).strip()
    return line


def _cuisine_from_types(types: list | None) -> str:
    if not types:
        return ""
    for x in types:
        if isinstance(x, str) and x.endswith("_restaurant") and x != "restaurant":
            s = x[: -len("_restaurant")].replace("_", " ")
            return " ".join(p.capitalize() for p in s.split()) if s else ""
    return ""


def _sql_escape(s: str) -> str:
    return s.replace("'", "''")


def _sql_text_literal(val: str | None) -> str:
    if val is None or not str(val).strip():
        return "NULL"
    return "'" + _sql_escape(str(val).strip()) + "'"


def _fetch_list_items(url: str, anon: str) -> list[dict]:
    out: list[dict] = []
    offset = 0
    page = 500
    sel = "list_id,rank,name,address,city,cuisine,url,lat,lng,place_id"
    while True:
        q = (
            f"{url.rstrip('/')}/rest/v1/list_items?select={sel}"
            f"&order=list_id.asc,rank.asc&limit={page}&offset={offset}"
        )
        req = urllib.request.Request(
            q,
            headers={
                "apikey": anon,
                "Authorization": f"Bearer {anon}",
                "Accept": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            batch = json.load(r)
        if not isinstance(batch, list) or not batch:
            break
        out.extend(batch)
        if len(batch) < page:
            break
        offset += page
    return out


def _run_sql_file(sql_path: Path) -> None:
    proc = subprocess.run(
        ["supabase", "db", "query", "--linked", "-f", str(sql_path)],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout or "")
        sys.stderr.write(proc.stderr or "")
        raise SystemExit(proc.returncode)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true", help="Print actions only; no SQL applied")
    ap.add_argument("--limit", type=int, default=0, help="Max rows to resolve (0 = all missing place_id)")
    args = ap.parse_args()

    gkey = _google_key()
    if not gkey:
        raise SystemExit(
            "Set GOOGLE_MAPS_API_KEY (or GOOGLE_MAPS_API_KEY_FILE) to call Google Places."
        )

    base = os.environ.get("SUPABASE_URL", DEFAULT_SUPABASE_URL).rstrip("/")
    anon = os.environ.get("SUPABASE_ANON_KEY", DEFAULT_SUPABASE_ANON_KEY)

    rows = _fetch_list_items(base, anon)
    todo = [r for r in rows if not (r.get("place_id") or "").strip()]
    if args.limit and args.limit > 0:
        todo = todo[: args.limit]
    print(f"list_items total={len(rows)} will_process={len(todo)}")

    stmts: list[str] = ["begin;"]
    notes: list[str] = []
    denied = False

    for r in todo:
        lid = r.get("list_id")
        rank = r.get("rank")
        name = (r.get("name") or "").strip()
        if not lid or rank is None or not name:
            notes.append(f"skip bad row {r}")
            continue

        addr = (r.get("address") or "").strip() or None
        city = (r.get("city") or "").strip() or None
        lat = r.get("lat")
        lng = r.get("lng")
        lat_n = float(lat) if lat is not None and str(lat).strip() != "" else None
        lng_n = float(lng) if lng is not None and str(lng).strip() != "" else None

        try:
            pid, pname = _find_place_id(gkey, name, addr, city, lat_n, lng_n)
            if not pid:
                pid, pname = _find_place_id(gkey, name, None, city, lat_n, lng_n)
            if not pid:
                notes.append(f"NO_MATCH rank={rank} name={name!r} google_name={pname!r}")
                time.sleep(0.12)
                continue

            det = _place_details(gkey, pid)
            gname = (det.get("name") or name).strip()
            comps = det.get("address_components") or []
            street = _pick_route_line(comps) or (det.get("formatted_address") or "").split(",")[0].strip()
            locality = _pick_locality(comps)
            w = (det.get("website") or "").strip() or None
            types = det.get("types")
            types_sql = "NULL"
            if isinstance(types, list) and types:
                escaped = [t.replace("'", "''") for t in types if isinstance(t, str)]
                if escaped:
                    types_sql = "ARRAY[" + ",".join("'" + t + "'" for t in escaped) + "]::text[]"

            geom = (det.get("geometry") or {}).get("location") or {}
            dlat = geom.get("lat")
            dlng = geom.get("lng")
            lat_sql = "NULL" if dlat is None else str(float(dlat))
            lng_sql = "NULL" if dlng is None else str(float(dlng))

            stmts.append(
                f"update public.list_items set place_id = '{_sql_escape(pid)}' "
                f"where list_id = '{lid}'::uuid and rank = {int(rank)};"
            )

            cu = _cuisine_from_types(types if isinstance(types, list) else None) or (
                (r.get("cuisine") or "").strip() or None
            )
            addr_sql = _sql_text_literal(street)
            city_sql = _sql_text_literal(locality)
            cuisine_sql = _sql_text_literal(str(cu) if cu else None)
            url_sql = _sql_text_literal(w)
            stmts.append(
                "insert into public.places (place_id, name, address, city, cuisine, url, lat, lng, types, updated_at) values ("
                f"'{_sql_escape(pid)}', '{_sql_escape(gname)}', {addr_sql}, {city_sql}, {cuisine_sql}, {url_sql}, "
                f"{lat_sql}, {lng_sql}, {types_sql}, now()) "
                "on conflict (place_id) do update set "
                "name = excluded.name, address = excluded.address, city = excluded.city, "
                "cuisine = excluded.cuisine, url = excluded.url, lat = excluded.lat, lng = excluded.lng, "
                "types = excluded.types, updated_at = excluded.updated_at;"
            )

            notes.append(f"OK rank={rank} name={name!r} -> {pid} ({gname})")
        except Exception as e:
            msg = str(e)
            notes.append(f"ERR rank={rank} name={name!r}: {e}")
            if "REQUEST_DENIED" in msg or "INVALID_REQUEST" in msg:
                denied = True
                break

        time.sleep(0.12)

    if denied:
        for line in notes[:20]:
            print(line)
        raise SystemExit(1)

    stmts.append("commit;")

    for line in notes[:50]:
        print(line)
    if len(notes) > 50:
        print(f"... {len(notes) - 50} more lines")

    if args.dry_run:
        print("--dry-run: not writing SQL")
        return

    fd, tmp = tempfile.mkstemp(prefix="top100_place_ids_", suffix=".sql")
    os.close(fd)
    sql_path = Path(tmp)
    try:
        sql_path.write_text("\n".join(stmts) + "\n", encoding="utf-8")
        n_apply = max(0, len(stmts) - 2)
        print(f"Applying {n_apply} statements via supabase db query --linked -f {sql_path}")
        _run_sql_file(sql_path)
    finally:
        try:
            sql_path.unlink(missing_ok=True)
        except OSError:
            pass


if __name__ == "__main__":
    main()
