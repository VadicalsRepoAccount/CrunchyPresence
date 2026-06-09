"""
CrunchyPresence · rpc.py
────────────────────────────────────────────────────────────────────────────────
Entry point.  Run this first, then open a Crunchyroll watch page.

    python rpc.py

Requirements:
    pip install pypresence websockets requests beautifulsoup4

Discord Application:
    1. Go to https://discord.com/developers/applications
    2. Create a new application (e.g. "CrunchyPresence" or "Crunchyroll")
    3. Copy the Application ID into CLIENT_ID below
    4. Upload your Rich Presence art assets under Rich Presence → Art Assets
       Recommended keys: crunchyroll_logo, play_icon, pause_icon
"""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from typing import Any

from pypresence.presence import AioPresence
from pypresence import InvalidPipe, PyPresenceException

from adapters.crunchyroll import build_payload, PresencePayload
from websocket_server import BridgeServer

# ── Config ────────────────────────────────────────────────────────────────────

# Replace with your Discord Application (Client) ID
CLIENT_ID = "HEREHEREHEREHEREHERE"

# How many seconds of inactivity before clearing Discord presence
IDLE_TIMEOUT = 60

# ── Logging ───────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("CrunchyPresence")

# ── State ─────────────────────────────────────────────────────────────────────

class PresenceBridge:
    def __init__(self):
        self.rpc: AioPresence | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._last_payload: PresencePayload | None = None
        self._idle_task: asyncio.Task | None = None
        self._connected = False
        self._lock = asyncio.Lock()

    # ── Discord RPC connection ────────────────────────────────────────────────

    async def connect_rpc(self):
        while True:
            try:
                self.rpc = AioPresence(CLIENT_ID)
                await self.rpc.connect()
                self._connected = True
                logger.info("Discord RPC connected.")
                return
            except InvalidPipe:
                logger.warning("Discord not running or pipe not found — retrying in 10s…")
                await asyncio.sleep(10)
            except Exception as e:
                logger.error(f"RPC connect error: {e} — retrying in 10s…")
                await asyncio.sleep(10)

    async def _ensure_rpc(self):
        if not self._connected or self.rpc is None:
            await self.connect_rpc()

    # ── Presence update ───────────────────────────────────────────────────────

    def on_update(self, raw: dict):
        """Called from the WebSocket handler (sync context — schedule coroutine)."""
        assert self._loop is not None
        self._loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._async_update(raw))
        )

    async def _async_update(self, raw: dict):
        if self._lock.locked():
            return  # drop concurrent update
        async with self._lock:
            await self._ensure_rpc()
            try:
                payload = build_payload(raw)
                await self._push(payload)
                self._schedule_idle_clear()
            except Exception as e:
                logger.error(f"Failed to update presence: {e}")

    def _payload_changed(self, p: PresencePayload) -> bool:
        """Only push to Discord when something meaningful changed."""
        prev = self._last_payload
        if prev is None:
            return True
        return (
            prev.details     != p.details  or
            prev.state       != p.state    or
            prev.small_image != p.small_image  # play/pause toggled
        )

    async def _push(self, payload: PresencePayload):
        if not self._payload_changed(payload):
            return  # nothing worth updating — stay quiet

        kwargs: dict[str, Any] = dict(
            details     = payload.details,
            state       = payload.state,
            large_image = payload.large_image,
            large_text  = payload.large_text,
            small_image = payload.small_image,
            small_text  = payload.small_text,
        )
        if payload.start is not None:
            kwargs["start"] = payload.start
        if payload.end is not None:
            kwargs["end"] = payload.end
        if payload.buttons:
            kwargs["buttons"] = payload.buttons

        try:
            assert self.rpc is not None
            await self.rpc.update(**kwargs)
            self._last_payload = payload
            logger.info(f"RPC  {payload.details!r}  |  {payload.state!r}")
        except PyPresenceException as e:
            logger.error(f"pypresence error: {e}")
            self._connected = False  # will reconnect on next update

    # ── Clear presence ────────────────────────────────────────────────────────

    def on_clear(self):
        assert self._loop is not None
        self._loop.call_soon_threadsafe(
            lambda: asyncio.ensure_future(self._async_clear())
        )

    async def _async_clear(self):
        await self._ensure_rpc()
        try:
            assert self.rpc is not None
            await self.rpc.clear()
            logger.info("RPC presence cleared.")
        except Exception as e:
            logger.warning(f"Could not clear presence: {e}")

    # ── Idle auto-clear ───────────────────────────────────────────────────────

    def _schedule_idle_clear(self):
        if self._idle_task and not self._idle_task.done():
            self._idle_task.cancel()
        self._idle_task = asyncio.ensure_future(self._idle_clear_after())

    async def _idle_clear_after(self):
        await asyncio.sleep(IDLE_TIMEOUT)
        logger.info(f"No update for {IDLE_TIMEOUT}s — clearing presence.")
        await self._async_clear()


# ── Main ──────────────────────────────────────────────────────────────────────

async def main():
    bridge = PresenceBridge()
    bridge._loop = asyncio.get_running_loop()

    # Start Discord RPC connection (will retry until Discord is open)
    logger.info("Connecting to Discord RPC…")
    await bridge.connect_rpc()

    # Start WebSocket server
    server = BridgeServer(on_update=bridge.on_update, on_clear=bridge.on_clear)
    await server.start()

    logger.info("─" * 60)
    logger.info("CrunchyPresence is running.")
    logger.info("Open any Crunchyroll watch page to start sharing.")
    logger.info("Press Ctrl+C to stop.")
    logger.info("─" * 60)

    # Graceful shutdown
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _shutdown():
        logger.info("Shutting down…")
        stop_event.set()

    try:
        loop.add_signal_handler(signal.SIGINT,  _shutdown)
        loop.add_signal_handler(signal.SIGTERM, _shutdown)
    except NotImplementedError:
        pass  # Windows — handled by KeyboardInterrupt below

    try:
        await stop_event.wait()
    except KeyboardInterrupt:
        pass

    await server.stop()
    if bridge.rpc:
        await bridge.rpc.clear()
        bridge.rpc.close()
    logger.info("Goodbye.")


if __name__ == "__main__":
    if CLIENT_ID == "YOUR_DISCORD_APPLICATION_ID":
        print(
            "\n⚠  Set CLIENT_ID in rpc.py before running.\n"
            "   Get one at: https://discord.com/developers/applications\n"
        )
        sys.exit(1)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass