// Firefox/Chrome compat shim
const _chrome = typeof browser !== "undefined" ? browser : chrome;

// ─── CrunchyPresence · content.js ───────────────────────────────────────────
// Crunchyroll uses Bitmovin + a heavy React app that renders titles async.
// Strategy: poll aggressively on startup until we get real data, then slow down.
// Handles SPA navigation — resets and re-initialises when the watch URL changes.

const FAST_INTERVAL = 2000;  // ms — used until we get a good scrape
const SLOW_INTERVAL = 5000;  // ms — once we have data

let intervalId   = null;
let lastPayload  = null;
let goodScrapes  = 0;
let currentUrl   = location.href;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMediaId() {
  // Handles trailing slugs: /watch/GN7UDZ19Q/episode-title--
  const m = location.pathname.match(/\/watch\/([A-Z0-9]+)/i);
  return m ? m[1] : null;
}

function queryText(...selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) return el.textContent.trim();
    } catch (_) {}
  }
  return null;
}

function getVideo() {
  const v = document.querySelector("video");
  return v && v.readyState >= 1 ? v : null;
}

function getThumbnail() {
  const og = document.querySelector('meta[property="og:image"]');
  if (og && og.content) return og.content;
  const v = document.querySelector("video");
  if (v && v.poster) return v.poster;
  return null;
}

// ── Title extraction ──────────────────────────────────────────────────────────
// Crunchyroll's React app uses hashed class names (e.g. "title-XKJA3").
// We target by tag structure and data attributes instead of class names.

function extractTitles() {
  let seriesTitle  = null;
  let episodeTitle = null;
  let episodeMeta  = null;

  // ── Strategy 1: og:title (most reliable, set server-side)
  // Format varies:
  //   "Series Name | E## - Ep Title"  (series first)
  //   "E## - Ep Title - Series Name"  (series last)
  //   "Series Name"                   (no episode info)
  const ogTitle = document.querySelector('meta[property="og:title"]')?.content?.trim();
  if (ogTitle) {
    const parts = ogTitle.split(/\s[–—\-|]\s/);
    if (parts.length >= 2) {
      // Detect which part starts with an episode code (E##) to resolve order.
      const epIndex = parts.findIndex(p => /^E\d+\b/i.test(p.trim()));
      if (epIndex === 0) {
        // "E18 - Sage - JUJUTSU KAISEN" — series is last
        seriesTitle  = parts[parts.length - 1].trim();
        episodeTitle = parts.slice(0, parts.length - 1).join(" – ").trim();
      } else if (epIndex > 0) {
        // "JUJUTSU KAISEN | E18 - Sage" — series is before the episode code
        seriesTitle  = parts.slice(0, epIndex).join(" – ").trim();
        episodeTitle = parts.slice(epIndex).join(" – ").trim();
      } else {
        // No episode code found — fall back to original assumption (series last)
        seriesTitle  = parts[parts.length - 1].trim();
        episodeTitle = parts.slice(0, parts.length - 1).join(" – ").trim();
      }
    } else {
      seriesTitle = ogTitle;
    }
  }

  // ── Strategy 2: <title> tag
  // Format: "Watch Series Name – Ep Title | Crunchyroll"
  if (!seriesTitle || !episodeTitle) {
    const pageTitle = document.title?.trim();
    if (pageTitle) {
      const noSuffix = pageTitle.replace(/\s*[|–—]\s*Crunchyroll\s*$/i, "").trim();
      const parts = noSuffix.split(/\s[–—\-]\s/);
      if (parts.length >= 2) {
        seriesTitle  = seriesTitle  || parts[parts.length - 1].trim();
        episodeTitle = episodeTitle || parts.slice(0, parts.length - 1).join(" – ").trim();
      } else {
        seriesTitle = seriesTitle || noSuffix;
      }
    }
  }

  // ── Strategy 3: DOM — stable data-t attributes and tag structure
  if (!episodeTitle) {
    episodeTitle =
      queryText('[data-t="title"]', '[data-t="episode-title"]') ||
      queryText('h1 ~ p', 'h1 + h4', 'h1 + p') ||
      queryText('h4[class*="title"]', 'p[class*="title"]');
  }
  if (!seriesTitle) {
    seriesTitle =
      queryText('[data-t="series-title"]') ||
      queryText('h1[class*="title"]', 'h1');
  }

  // ── Strategy 4: episode number from breadcrumb / meta region
  episodeMeta =
    queryText('[data-t="episode-number"]') ||
    queryText('[class*="episode-number"]', '[class*="EpisodeNumber"]') ||
    null;

  // ── Strategy 5: pull "E##" prefix out of episodeTitle if episodeMeta is
  // still empty. This handles og:title like "E18 - Sage - JUJUTSU KAISEN"
  // which Strategy 1 collapses into episodeTitle = "E18 – Sage".
  if (!episodeMeta && episodeTitle) {
    const epMatch = episodeTitle.match(/^(E\d+)\s*[-–—]\s*/i);
    if (epMatch) {
      episodeMeta  = epMatch[1];                             // "E18"
      episodeTitle = episodeTitle.slice(epMatch[0].length).trim(); // "Sage"
    }
  }

  return { seriesTitle, episodeTitle, episodeMeta };
}

// ── Main scraper ──────────────────────────────────────────────────────────────

function scrapePresence() {
  const video = getVideo();
  const { seriesTitle, episodeTitle, episodeMeta } = extractTitles();

  return {
    mediaId:      getMediaId(),
    url:          location.href,
    seriesTitle:  seriesTitle  || "Crunchyroll",
    episodeTitle: episodeTitle || document.title?.split(/[|–]/)[0]?.trim() || "Watching",
    episodeMeta:  episodeMeta  || null,
    thumbnail:    getThumbnail(),
    currentTime:  video ? Math.floor(video.currentTime) : null,
    duration:     video ? Math.floor(video.duration)    : null,
    paused:       video ? video.paused                  : true,
    timestamp:    Date.now(),
  };
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

function maybeUpdate() {
  try {
    const data = scrapePresence();

    const hasGoodData =
      data.mediaId &&
      data.seriesTitle  !== "Crunchyroll" &&
      data.episodeTitle !== "Watching";

    const changed =
      !lastPayload ||
      lastPayload.paused       !== data.paused       ||
      lastPayload.seriesTitle  !== data.seriesTitle  ||
      lastPayload.episodeTitle !== data.episodeTitle ||
      Math.abs((lastPayload.currentTime || 0) - (data.currentTime || 0)) > 4;

    if (changed) {
      lastPayload = data;
      _chrome.runtime.sendMessage({ type: "presence_update", data });
      console.debug("[CrunchyPresence] Sent update:", data.seriesTitle, "·", data.episodeTitle);
    }

    // Slow down once we've confirmed good data is flowing
    if (hasGoodData && ++goodScrapes >= 2 && intervalId) {
      clearInterval(intervalId);
      intervalId = setInterval(maybeUpdate, SLOW_INTERVAL);
      console.debug("[CrunchyPresence] Switched to slow polling.");
    }

  } catch (err) {
    console.debug("[CrunchyPresence] Scrape error (will retry):", err.message);
  }
}

// ── Poll management ───────────────────────────────────────────────────────────

function startPolling() {
  if (intervalId) clearInterval(intervalId);
  goodScrapes = 0;
  lastPayload = null;
  intervalId  = null;

  waitForPlayer(() => {
    console.debug("[CrunchyPresence] Player ready, starting poll.");
    maybeUpdate();
    intervalId = setInterval(maybeUpdate, FAST_INTERVAL);
  });
}

// ── SPA navigation detection ──────────────────────────────────────────────────
// Crunchyroll is a React SPA — navigating between episodes never triggers a
// full page reload, so content scripts are not re-injected. We watch for URL
// changes via a MutationObserver on the <title> element (cheapest reliable
// signal that React has committed a new route) and restart the poll loop.

function onNavigate() {
  const newUrl = location.href;
  if (newUrl === currentUrl) return;
  currentUrl = newUrl;

  if (!getMediaId()) return; // not a watch page, ignore

  console.debug("[CrunchyPresence] SPA navigation detected, restarting.");
  startPolling();
}

const titleObserver = new MutationObserver(onNavigate);
const titleEl = document.querySelector("title");
if (titleEl) {
  titleObserver.observe(titleEl, { childList: true });
}

// Fallback: also catch popstate / pushState navigation
window.addEventListener("popstate", onNavigate);
const _origPushState = history.pushState.bind(history);
history.pushState = (...args) => { _origPushState(...args); onNavigate(); };
const _origReplaceState = history.replaceState.bind(history);
history.replaceState = (...args) => { _origReplaceState(...args); onNavigate(); };

// ── Wait for player ───────────────────────────────────────────────────────────

function waitForPlayer(callback, maxWait = 15000) {
  const start = Date.now();
  function check() {
    const videoReady = !!document.querySelector("video");
    const titleReady = !!(
      document.querySelector('meta[property="og:title"]')?.content ||
      (document.title && document.title !== "Crunchyroll")
    );
    if (videoReady && titleReady) {
      callback();
    } else if (Date.now() - start < maxWait) {
      setTimeout(check, 500);
    } else {
      console.debug("[CrunchyPresence] Timed out waiting for player — starting anyway.");
      callback();
    }
  }
  check();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

startPolling();

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) maybeUpdate();
});