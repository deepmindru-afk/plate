"""LiveKit Agents worker for the Plate + LiveKit realtime example.

The worker joins each collaboration room as an "agent" participant and is the
anchor for persistence + backfill. It does NOT re-broadcast updates: LiveKit's
SFU already fans every reliable `/plate-yjs` data packet out to every room
participant, so each client's Y.Doc converges directly.

The agent instead owns two things the pure-P2P flow lacks:

* PERSISTENCE  — it records every Yjs update delta it sees, per room, to disk
  (append-only log, since Yjs updates are an append-only CRDT).
* BACKFILL — when a new participant joins, it re-publishes the accumulated
  update log to *that* participant only, so a fresh client's Y.Doc converges
  even though it missed earlier traffic.

The actual Yjs CRDT merge lives in the browser clients via @platejs/yjs; that
is the standard split and avoids a server-side Yjs dependency.

Run with:
    uv run --with livekit-agents --with livekit livekit-agents start
"""

from __future__ import annotations

import base64
import json
import logging
import os
import re
from pathlib import Path

from dotenv import load_dotenv

from livekit import agents, rtc

load_dotenv()

logger = logging.getLogger("plate-livekit-agent")

TOPIC = "plate-yjs"
TAG_UPDATE = 0x01
TAG_AWARENESS = 0x02

STORE_DIR = Path(
    os.getenv("PLATE_STORE_DIR", str(Path(__file__).parent / "store"))
)
STORE_DIR.mkdir(parents=True, exist_ok=True)


def _safe_room_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", name) or "default"


class RoomStore:
    """Append-only log of Yjs update deltas for one room, persisted to disk."""

    def __init__(self, room: str) -> None:
        self.room = room
        self.deltas: list[bytes] = []
        self.path = STORE_DIR / f"{_safe_room_name(room)}.json"
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text())
            self.deltas = [
                base64.b64decode(d) for d in data.get("deltas", [])
            ]
            logger.info(
                "Loaded %d deltas for room %s", len(self.deltas), self.room
            )
        except Exception:  # noqa: BLE001
            logger.exception("Failed to load store for room %s", self.room)

    def append(self, delta: bytes) -> None:
        self.deltas.append(delta)
        try:
            self.path.write_text(
                json.dumps(
                    {
                        "room": self.room,
                        "deltas": [
                            base64.b64encode(d).decode() for d in self.deltas
                        ],
                    }
                )
            )
        except Exception:  # noqa: BLE001
            logger.exception("Failed to persist room %s", self.room)

    def full_state(self) -> list[bytes]:
        """Every accumulated Yjs update delta, replayable to a fresh client.

        Each delta is an independent, valid Yjs update; Yjs is an append-only
        CRDT so replaying them to a new document converges. They are returned
        separately (not concatenated) because concatenated raw deltas are not a
        valid single Yjs update.
        """
        return list(self.deltas)


_STORES: dict[str, RoomStore] = {}


def _get_store(room: str) -> RoomStore:
    if room not in _STORES:
        _STORES[room] = RoomStore(room)
    return _STORES[room]


server = agents.AgentServer()


@server.rtc_session(agent_name="plate-yjs")
async def plate_yjs_participant(ctx: agents.JobContext) -> None:
    room = ctx.room
    store = _get_store(room.name)

    logger.info("Agent joined room %s", room.name)

    @room.on("data_received")
    def on_data_received(data: rtc.DataPacket) -> None:
        payload = data.data
        if not payload:
            return
        tag = payload[0]

        if tag == TAG_UPDATE:
            delta = payload[1:]
            # Persist every unique incoming delta for backfill + survival.
            store.append(delta)

    @room.on("participant_connected")
    async def on_participant_connected(p: rtc.RemoteParticipant) -> None:
        # Backfill this specific newcomer with every accumulated delta so its
        # fresh Y.Doc converges despite missing prior traffic.
        deltas = store.full_state()
        if not deltas:
            return
        for delta in deltas:
            framed = bytes([TAG_UPDATE]) + delta
            try:
                await room.local_participant.publish_data(
                    framed,
                    reliable=True,
                    topic=TOPIC,
                    destination_identities=[p.identity],
                )
            except Exception:  # noqa: BLE001
                logger.exception(
                    "Backfill failed for %s in %s", p.identity, room.name
                )


if __name__ == "__main__":
    agents.cli.run_app(server)
