#!/usr/bin/env python3
"""
Resolve official establishment websites for data/nyc-list.json using Google Places.

Requires: GOOGLE_MAPS_API_KEY in the environment.

Usage:
  GOOGLE_MAPS_API_KEY=... python3 scripts/resolve_nyc_official_urls.py
"""

from __future__ import annotations

import json
import os
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
LIST_PATH = ROOT / "data" / "nyc-list.json"

# Hosts we never want as the canonical establishment URL.
_BLOCKED_NETLOCS = frozenset(
    {
        "foursquare.com",
        "www.foursquare.com",
        "nytimes.com",
        "www.nytimes.com",
        "eater.com",
        "www.eater.com",
        "sf.eater.com",
        "grubhub.com",
        "www.grubhub.com",
        "ubereats.com",
        "www.ubereats.com",
        "doordash.com",
        "www.doordash.com",
        "seamless.com",
        "www.seamless.com",
        "postmates.com",
        "www.postmates.com",
        "yelp.com",
        "www.yelp.com",
        "tripadvisor.com",
        "www.tripadvisor.com",
        "safegraph.com",
        "reservations.safegraph.com",
        "maps.google.com",
        "www.google.com",
        "google.com",
        "instagram.com",
        "www.instagram.com",
        "facebook.com",
        "www.facebook.com",
        "m.facebook.com",
        "tiktok.com",
        "www.tiktok.com",
        "twitter.com",
        "www.twitter.com",
        "x.com",
        "www.x.com",
        "toasttab.com",
        "order.toasttab.com",
        "chownow.com",
        "direct.chownow.com",
        "order.online",
        "www.order.online",
    }
)


def _host_blocked(host: str) -> bool:
    h = host.lower().strip(".")
    if h in _BLOCKED_NETLOCS:
        return True
    if h.endswith(".toasttab.com") or h.endswith(".chownow.com"):
        return True
    if h.endswith(".grubhub.com") or h.endswith(".ubereats.com"):
        return True
    if h.endswith(".eater.com"):
        return True
    return False


def _is_bad_url(url: str | None) -> bool:
    if not url or not isinstance(url, str):
        return True
    u = url.strip()
    if not u:
        return True
    try:
        p = urlparse(u)
    except Exception:
        return True
    host = (p.netloc or "").lower()
    if not host:
        return True
    if _host_blocked(host):
        return True
    # Raw Google Maps short links / cid
    if "google.com" in host and ("cid=" in u or "/maps" in p.path):
        return True
    # Obvious wrong matches (seen in list)
    if "northwell.edu" in host:
        return True
    return False


def _normalize_website(url: str) -> str:
    u = url.strip()
    p = urlparse(u)
    if p.scheme not in ("http", "https"):
        u = "https://" + u.lstrip("/")
        p = urlparse(u)
    # Drop default path noise for known-good hosts
    if (p.path or "/") in ("/", "/index.html", "/home"):
        path = ""
    else:
        path = p.path or ""
    # Strip trailing slash for cleaner URLs (optional)
    if path.endswith("/") and path.count("/") == 1:
        path = path.rstrip("/")
    q = urllib.parse.urlunparse(
        (p.scheme or "https", p.netloc.lower(), path, "", "", "")
    )
    return q


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
    inter = a & b
    if len(inter) >= 1:
        return True
    wl = want_name.lower()
    pl = place_name.lower()
    return wl in pl or pl in wl


def _http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "top100-url-resolver/1.0"})
    with urllib.request.urlopen(req, timeout=35) as r:
        return json.load(r)


def _find_place_id(key: str, name: str, address: str | None, lat: float | None, lng: float | None) -> str | None:
    parts = [name]
    if address:
        parts.append(address)
    parts.append("New York NY")
    query = ", ".join(p for p in parts if p)
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
    if st not in ("OK", "ZERO_RESULTS"):
        raise RuntimeError(f"findplacefromtext {st}: {j.get('error_message')}")
    cands = j.get("candidates") or []
    if not cands:
        return None
    pid = cands[0].get("place_id")
    pname = cands[0].get("name") or ""
    if not _name_plausible(pname, name):
        return None
    return pid


def _place_details(key: str, place_id: str) -> dict:
    params = {
        "place_id": place_id,
        "fields": "name,website,url",
        "key": key,
    }
    url = "https://maps.googleapis.com/maps/api/place/details/json?" + urllib.parse.urlencode(params)
    j = _http_json(url)
    if j.get("status") != "OK":
        raise RuntimeError(f"details {j.get('status')}: {j.get('error_message')}")
    return j.get("result") or {}


def main() -> None:
    key = os.environ.get("GOOGLE_MAPS_API_KEY")
    if not key:
        raise SystemExit("Set GOOGLE_MAPS_API_KEY")

    data = json.loads(LIST_PATH.read_text())
    changed = 0
    cleared = 0
    notes: list[tuple[int, str, str]] = []

    for item in data:
        rank = item.get("rank")
        name = item.get("name") or ""
        addr = item.get("full_address") or item.get("address")
        lat, lng = item.get("lat"), item.get("lng")
        old = item.get("url")

        try:
            pid = _find_place_id(key, name, addr, lat, lng)
            if not pid:
                pid = _find_place_id(key, name, None, lat, lng)
            website = None
            gname = None
            if pid:
                det = _place_details(key, pid)
                gname = det.get("name") or ""
                w = (det.get("website") or "").strip()
                if w and not _is_bad_url(w):
                    website = _normalize_website(w)
                elif w and _host_blocked(urlparse(w).netloc.lower()):
                    website = None

            new_url: str | None
            if website:
                new_url = website
            elif old and not _is_bad_url(old):
                new_url = _normalize_website(old) if old.startswith("http") else old
            else:
                new_url = None

            if new_url != old:
                if new_url is None:
                    cleared += 1
                else:
                    changed += 1
                item["url"] = new_url
                notes.append((rank, name, f"{old!r} -> {new_url!r} ({gname})"))

        except Exception as e:
            notes.append((rank, name, f"ERROR {e}"))
            if old and _is_bad_url(old):
                item["url"] = None
                cleared += 1

        time.sleep(0.12)

    LIST_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    print(f"wrote {LIST_PATH}")
    print(f"urls_changed={changed} urls_cleared_bad_only={cleared}")
    for row in notes[:30]:
        print(row)
    if len(notes) > 30:
        print(f"... and {len(notes) - 30} more lines in log (truncated)")


if __name__ == "__main__":
    main()
