// Firefox/Chrome compat shim
const _chrome = typeof browser !== "undefined" ? browser : chrome;

// ─── CrunchyPresence · popup.js ─────────────────────────────────────────────

const $ = id => document.getElementById(id);

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTime(secs) {
  if (!secs || isNaN(secs)) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateBridgeStatus(status) {
  const dot   = $("bridge-dot");
  const label = $("bridge-label");
  if (status === "connected") {
    dot.className     = "dot ok";
    label.textContent = "Bridge connected";
  } else if (status === "error") {
    dot.className     = "dot error";
    label.textContent = "Bridge offline — run rpc.py";
  } else {
    dot.className     = "dot";
    label.textContent = "Connecting to bridge…";
  }
}

// ── Presence rendering ────────────────────────────────────────────────────────

let _presence  = null;   // last known presence snapshot
let _tickTimer = null;   // setInterval handle for live progress ticking

function renderPresence(data) {
  _presence = data;

  if (!data) {
    $("now-watching").hidden      = true;
    $("idle-state").hidden        = false;
    $("status-badge").textContent = "—";
    $("status-badge").className   = "badge";
    stopTicker();
    return;
  }

  $("now-watching").hidden = false;
  $("idle-state").hidden   = true;

  $("series-title").textContent  = data.seriesTitle  || "Unknown Series";
  $("episode-title").textContent = data.episodeTitle || "Unknown Episode";
  $("episode-meta").textContent  = data.episodeMeta  || "";

  // Thumbnail
  if (data.thumbnail) {
    $("thumb").src           = data.thumbnail;
    $("thumb").style.display = "";
  } else {
    $("thumb").style.display = "none";
  }

  // Badge
  const badge = $("status-badge");
  if (data.paused) {
    badge.textContent = "Paused";
    badge.className   = "badge paused";
    stopTicker();
    // Still render the static position
    updateProgress(data.currentTime, data.duration);
  } else {
    badge.textContent = "▶ Watching";
    badge.className   = "badge playing";
    startTicker(data);
  }
}

function updateProgress(currentTime, duration) {
  const pct = duration ? (currentTime / duration) * 100 : 0;
  $("progress-fill").style.width = `${Math.min(pct, 100).toFixed(1)}%`;
  $("current-time").textContent  = fmtTime(currentTime);
  $("duration").textContent      = fmtTime(duration);
}

// Tick the progress bar in real-time while playing.
// The stored snapshot has a `timestamp` (ms epoch) so we know how old it is.
function startTicker(data) {
  stopTicker();
  function tick() {
    if (!_presence || _presence.paused) { stopTicker(); return; }
    const elapsed = (Date.now() - (_presence.timestamp || Date.now())) / 1000;
    const current = (_presence.currentTime || 0) + elapsed;
    updateProgress(current, _presence.duration);
  }
  tick(); // immediate first paint
  _tickTimer = setInterval(tick, 1000);
}

function stopTicker() {
  if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

// Load persisted state immediately (no flicker)
_chrome.storage.local.get(["bridgeStatus", "bridgeDetail", "lastPresence"], (result) => {
  updateBridgeStatus(result.bridgeStatus || "disconnected");
  renderPresence(result.lastPresence || null);
});

// Live updates while popup is open
_chrome.storage.onChanged.addListener((changes) => {
  if (changes.bridgeStatus) {
    updateBridgeStatus(changes.bridgeStatus.newValue);
  }
  if (changes.lastPresence) {
    renderPresence(changes.lastPresence.newValue || null);
  }
});

// Clear button
$("btn-clear").addEventListener("click", () => {
  _chrome.runtime.sendMessage({ type: "clear_presence" });
  renderPresence(null);
});