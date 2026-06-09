// ─── CrunchyPresence · background.js ────────────────────────────────────────
// Background script (MV2 — compatible with Firefox, Chrome, Edge).
//   1. Receives presence_update messages from content.js
//   2. Forwards them over a WebSocket to the local Python bridge (port 6969)
//   3. Tracks connection state and exposes it to popup.js via _chrome.storage

// Firefox uses `browser.*`; Chrome uses `chrome.*`. This shim covers both.
const _chrome = typeof browser !== "undefined" ? browser : chrome;

const WS_URL        = "ws://127.0.0.1:6969";
const PING_INTERVAL = 25000; // ms — keeps Firefox from suspending the background

// Reconnect backoff: starts at 500ms, doubles each attempt, caps at 30s
const RECONNECT_BASE = 500;
const RECONNECT_MAX  = 30000;
let reconnectDelay   = RECONNECT_BASE;
let reconnectTimer   = null;
let pingTimer        = null;

let ws           = null;
let connected    = false;
let pendingQueue = [];

// ── Connection management ────────────────────────────────────────────────────

function setState(status, detail = "") {
  _chrome.storage.local.set({ bridgeStatus: status, bridgeDetail: detail });
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, PING_INTERVAL);
}

function stopPing() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
}

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return; // already connecting/open

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    setState("error", e.message);
    scheduleReconnect();
    return;
  }

  ws.addEventListener("open", () => {
    connected = true;
    reconnectDelay = RECONNECT_BASE;
    setState("connected", WS_URL);
    startPing();

    // Flush anything queued while disconnected
    while (pendingQueue.length) {
      ws.send(pendingQueue.shift());
    }
  });

  ws.addEventListener("close", () => {
    connected = false;
    stopPing();
    setState("disconnected", "Retrying…");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    // "error" always fires immediately before "close" — let "close" handle reconnect
    connected = false;
    setState("error", "Cannot reach bridge — is rpc.py running?");
  });

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "error") {
        setState("error", msg.message);
      }
    } catch (_) {}
  });
}

function scheduleReconnect() {
  ws = null;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
    connect();
  }, reconnectDelay);
}

function send(payload) {
  const raw = JSON.stringify(payload);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(raw);
  } else {
    if (pendingQueue.length < 5) pendingQueue.push(raw);
    if (!reconnectTimer && (!ws || ws.readyState === WebSocket.CLOSED)) {
      reconnectDelay = RECONNECT_BASE;
      scheduleReconnect();
    }
  }
}

// ── Message listener (from content.js) ───────────────────────────────────────

_chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "presence_update") {
    send({ type: "presence_update", data: message.data });
    _chrome.storage.local.set({ lastPresence: message.data });
    sendResponse({ ok: true });
  } else if (message.type === "get_status") {
    _chrome.storage.local.get(["bridgeStatus", "bridgeDetail"], (result) => {
      sendResponse({
        status: result.bridgeStatus || "disconnected",
        detail: result.bridgeDetail || "",
      });
    });
  } else if (message.type === "clear_presence") {
    send({ type: "clear_presence" });
    _chrome.storage.local.remove("lastPresence");
    sendResponse({ ok: true });
  }

  return true;
});

// ── Boot ─────────────────────────────────────────────────────────────────────

setState("disconnected", "Starting…");
connect();