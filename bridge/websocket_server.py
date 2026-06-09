"""
CrunchyPresence · websocket_server.py
──────────────────────────────────────
Tiny asyncio WebSocket server on ws://127.0.0.1:6969
Receives JSON from the browser extension and calls the provided callback.
"""

import json
import logging
from typing import Callable

import websockets.exceptions
from websockets.asyncio.server import ServerConnection, serve

logger = logging.getLogger("CrunchyPresence.ws")

# Silence the noisy websockets.server logger — we handle connection events ourselves.
# The "opening handshake failed" spam comes from Firefox probing the port; it's harmless.
logging.getLogger("websockets.server").setLevel(logging.CRITICAL)
logging.getLogger("websockets").setLevel(logging.CRITICAL)

HOST = "127.0.0.1"
PORT = 6969


class BridgeServer:
    def __init__(self, on_update: Callable[[dict], None], on_clear: Callable[[], None]):
        self._on_update = on_update
        self._on_clear  = on_clear
        self._clients: set[ServerConnection] = set()
        self._server    = None

    async def _handler(self, ws: ServerConnection):
        self._clients.add(ws)
        logger.info(f"Extension connected from {ws.remote_address}")
        try:
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    logger.warning(f"Invalid JSON from extension: {raw!r}")
                    continue

                mtype = msg.get("type")

                if mtype == "ping":
                    pass  # keepalive — no response needed

                elif mtype == "presence_update":
                    data = msg.get("data", {})
                    try:
                        self._on_update(data)
                        await ws.send(json.dumps({"type": "ack"}))
                    except Exception as e:
                        logger.error(f"on_update raised: {e}")
                        await ws.send(json.dumps({"type": "error", "message": str(e)}))

                elif mtype == "clear_presence":
                    try:
                        self._on_clear()
                        await ws.send(json.dumps({"type": "ack"}))
                    except Exception as e:
                        logger.error(f"on_clear raised: {e}")

                else:
                    logger.warning(f"Unknown message type: {mtype!r}")

        except (websockets.exceptions.ConnectionClosedOK,
                websockets.exceptions.ConnectionClosedError):
            pass
        finally:
            self._clients.discard(ws)
            logger.info(f"Extension disconnected from {ws.remote_address}")

    async def start(self):
        self._server = await serve(self._handler, HOST, PORT)
        logger.info(f"WebSocket bridge listening on ws://{HOST}:{PORT}")
        return self._server

    async def stop(self):
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            logger.info("WebSocket bridge stopped.")