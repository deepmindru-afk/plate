"""FastAPI backend for the Plate + LiveKit realtime example.

Issues LiveKit access tokens for the editor clients. Kept deliberately small:
the realtime data path runs directly between the browser clients and the
LiveKit room, with the LiveKit Agents worker (in ../agent) acting as the Yjs
authority + persistence layer.
"""

from __future__ import annotations

import os
import uuid

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from livekit import api
from pydantic import BaseModel

load_dotenv()

LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET")
# Name of the LiveKit Agents worker (../agent) that serves as the Yjs
# authority. Auto-dispatching it means the agent is guaranteed present in every
# room. Set to "" to disable auto-dispatch (e.g. when your LiveKit server is
# configured with default agent dispatch).
PLATE_AGENT_NAME = os.getenv("PLATE_AGENT_NAME", "plate-yjs")

app = FastAPI(title="Plate + LiveKit token server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class TokenResponse(BaseModel):
    token: str
    wsUrl: str
    room: str


@app.get("/token", response_model=TokenResponse)
def get_token(
    room: str = Query(..., min_length=1),
    username: str = Query(default="", min_length=1),
) -> TokenResponse:
    """Issue a LiveKit join token for `room` as participant `username`."""
    if not LIVEKIT_API_KEY or not LIVEKIT_API_SECRET:
        raise HTTPException(
            status_code=500,
            detail="LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured on server",
        )

    identity = username or f"user-{uuid.uuid4().hex[:6]}"
    at = (
        api.AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
        .with_identity(identity)
        .with_grants(
            api.VideoGrants(
                room=room,
                room_join=True,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
    )

    # Auto-dispatch the Yjs agent into this room on creation, so the
    # persistence/backfill anchor is always present.
    if PLATE_AGENT_NAME:
        at = at.with_room_config(
            api.RoomConfiguration(
                agents=[api.RoomAgentDispatch(agent_name=PLATE_AGENT_NAME)]
            )
        )

    return TokenResponse(token=at.to_jwt(), wsUrl=LIVEKIT_URL, room=room)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
