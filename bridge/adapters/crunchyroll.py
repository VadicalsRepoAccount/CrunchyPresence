"""
CrunchyPresence · adapters/crunchyroll.py
──────────────────────────────────────────
Receives the raw dict scraped by content.js, optionally enriches it via
a quick HTTP fetch of the Crunchyroll watch page (for richer episode metadata),
and returns a clean PresencePayload ready for pypresence.
"""

from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass, field
from typing import Optional

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger("CrunchyPresence.crunchyroll")

# Cache fetched page data so we don't hammer CR on every 5-second tick.
_page_cache: dict[str, tuple[float, dict]] = {}  # mediaId → (timestamp, data)
CACHE_TTL  = 300   # seconds
CACHE_MAX  = 50    # evict oldest entries beyond this size

# Matches strings that are ONLY an episode code, e.g. "E18", "E1", "EP18"
_EP_CODE_RE = re.compile(r'^ep?\d+$', re.IGNORECASE)


@dataclass
class PresencePayload:
    """Everything pypresence needs to call update()."""
    details:     str           = "Watching anime"
    state:       str           = ""
    large_image: str           = "crunchyroll_logo"
    large_text:  str           = "Crunchyroll"
    small_image: Optional[str] = None
    small_text:  Optional[str] = None
    start:       Optional[int] = None   # epoch seconds — used for "elapsed" timer
    end:         Optional[int] = None   # epoch seconds — used for "remaining" timer
    buttons:     list[dict]    = field(default_factory=list)


def _fetch_page_meta(url: str) -> dict:
    """
    Do a single GET of the Crunchyroll watch page and extract:
      series_title, episode_title, episode_number, season_number, thumbnail_url
    Uses BeautifulSoup; falls back gracefully if anything is missing.
    Returns an empty dict on any error.
    """
    try:
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        }
        resp = requests.get(url, headers=headers, timeout=8)
        resp.raise_for_status()
        soup = BeautifulSoup(resp.text, "html.parser")

        meta: dict = {}

        # og:title  →  "Episode 1 – A Chance Meeting – Frieren: Beyond Journey's End"
        og_title = soup.find("meta", property="og:title")
        if og_title and og_title.get("content"):
            meta["og_title"] = og_title["content"]

        # og:image  →  episode thumbnail
        og_image = soup.find("meta", property="og:image")
        if og_image and og_image.get("content"):
            meta["thumbnail"] = og_image["content"]

        # og:description  →  episode synopsis (truncated)
        og_desc = soup.find("meta", property="og:description")
        if og_desc and og_desc.get("content"):
            meta["description"] = og_desc["content"][:120]

        # Structured episode data from JSON-LD block
        for tag in soup.find_all("script", type="application/ld+json"):
            try:
                obj = json.loads(tag.string or "")
                if isinstance(obj, list):
                    obj = next(
                        (x for x in obj if x.get("@type") == "TVEpisode"),
                        obj[0] if obj else {},
                    )
                if obj.get("@type") == "TVEpisode":
                    meta["series_title"]  = obj.get("partOfSeries", {}).get("name", "")
                    meta["episode_title"] = obj.get("name", "")
                    meta["episode_num"]   = obj.get("episodeNumber", "")
                    meta["season_num"]    = obj.get("partOfSeason", {}).get("seasonNumber", "")
                    if not meta.get("thumbnail") and obj.get("image"):
                        img = obj["image"]
                        meta["thumbnail"] = img[0] if isinstance(img, list) else img
                    break
            except Exception:
                pass

        return meta

    except requests.RequestException as e:
        logger.warning(f"Page fetch failed for {url}: {e}")
        return {}
    except Exception as e:
        logger.error(f"Unexpected error scraping {url}: {e}")
        return {}


def _get_cached_meta(media_id: str, url: str) -> dict:
    now = time.time()
    if media_id in _page_cache:
        ts, data = _page_cache[media_id]
        if now - ts < CACHE_TTL:
            return data

    data = _fetch_page_meta(url)
    _page_cache[media_id] = (now, data)

    # Evict oldest entries if cache has grown too large
    if len(_page_cache) > CACHE_MAX:
        oldest = sorted(_page_cache, key=lambda k: _page_cache[k][0])
        for key in oldest[:len(_page_cache) - CACHE_MAX]:
            del _page_cache[key]

    return data


def build_payload(raw: dict) -> PresencePayload:
    """
    Turn the raw dict from content.js into a PresencePayload.
    Enriches with a server-side page scrape if the mediaId is new.
    """
    media_id     = raw.get("mediaId")
    url          = raw.get("url", "")
    series_title = raw.get("seriesTitle", "Unknown Series")
    ep_title     = raw.get("episodeTitle", "Unknown Episode")
    ep_meta      = raw.get("episodeMeta") or ""   # e.g. "E18" from content.js
    current_time = raw.get("currentTime")          # int seconds or None
    duration     = raw.get("duration")             # int seconds or None
    paused       = raw.get("paused", True)
    thumbnail    = raw.get("thumbnail")

    # ── Server-side enrichment ─────────────────────────────────────────────
    # content.js already scraped good titles from the live page — trust those.
    # From the server-side fetch we only take: thumbnail and season/ep numbers.
    # We avoid overwriting series_title/ep_title with enriched values because
    # CR's JSON-LD is often malformed (e.g. name="Sage", partOfSeries="JJK – E18").
    if media_id and url:
        enriched = _get_cached_meta(media_id, url)

        thumbnail = enriched.get("thumbnail") or thumbnail

        # Build ep_meta from JSON-LD season/episode numbers if available;
        # otherwise keep whatever content.js already sent (e.g. "E18").
        if enriched.get("season_num") and enriched.get("episode_num"):
            ep_meta = f"S{enriched['season_num']} E{enriched['episode_num']}"
        elif enriched.get("episode_num") and not ep_meta:
            ep_meta = f"E{enriched['episode_num']}"
        # else: keep ep_meta from content.js

    # ── Strip stray trailing punctuation ──────────────────────────────────
    def clean(s: str | None) -> str | None:
        if not s:
            return s
        return re.sub(r'[\s\-–—|]+$', '', s).strip() or None

    series_title = clean(series_title) or "Watching anime"
    ep_title     = clean(ep_title)     or ""

    # Trim to Discord's 128-char limit
    # details = series title (top line), state = "E18 · Sage" (bottom line)
    details = series_title[:128]
    state   = ep_title[:128]
    if ep_meta:
        state = f"{ep_meta} · {state}"[:128]

    logger.debug(f"build_payload → details={details!r} state={state!r}")

    payload = PresencePayload(
        details     = details,
        state       = state,
        large_image = thumbnail or "crunchyroll_logo",
        large_text  = series_title[:128],
        small_image = "pause_icon" if paused else "play_icon",
        small_text  = "Paused"    if paused else "Watching",
        buttons     = [{"label": "Watch on Crunchyroll", "url": url}] if url else [],
    )

    # ── Timestamps ──────────────────────────────────────────────────────────
    # If playing: start = now − currentTime  (Discord shows "elapsed")
    #             end   = now + remaining     (Discord shows "time left")
    # If paused:  no timestamps (Discord would keep ticking, which is wrong)
    if not paused and current_time is not None:
        now = int(time.time())
        payload.start = now - current_time
        if duration:
            payload.end = now + (duration - current_time)

    return payload