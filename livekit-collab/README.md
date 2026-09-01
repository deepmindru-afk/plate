# Plate + LiveKit realtime collaboration

A runnable example of real-time collaborative editing with **Plate** (via its
`@platejs/yjs` plugin) carried over **LiveKit**. Multiple browser editors edit
the same document live; edits, cursors, and awareness sync through LiveKit's
data packets, anchored by a **LiveKit Agents** worker that persists the document
and backfills late joiners.

```
┌────────────┐   /token   ┌───────────────────┐   tokens   ┌─────────────┐
│  Browser A  │──────────▶│  FastAPI token     │◀──────────│  Browser B  │
│  Plate editor│           │  server (Python)   │           │  Plate editor│
└─────┬──────┘            └───────────────────┘            └─────┬──────┘
      │  Yjs updates / awareness (plate-yjs topic)               │
      └───────────────▶  LiveKit SFU  ◀─────────────────────────┘
                             │  data packets
                             ▼
                    ┌───────────────────┐   persists to   ┌──────────────┐
                    │  Agents worker     │ ───────────────▶│  store/*.json │
                    │  (Python, plate-yjs)│  backfills late │              │
                    └───────────────────┘  joiners         └──────────────┘
```

## How it works

* **Yjs CRDT, not y-websocket.** LiveKit does not expose raw
  `RTCPeerConnection.createDataChannel`, so you cannot run `y-websocket`'s or
  `y-webrtc`'s protocol over it. Instead `client/src/LiveKitProvider.ts`
  implements Plate's `UnifiedProvider` interface using LiveKit's message-based
  data packet API (`publishData` + `DataReceived`).
* **Wire format.** Every packet is `[1-byte tag][body]` on the `plate-yjs`
  topic: `0x01` = Yjs update, `0x02` = y-protocols awareness. Reliable delivery.
* **Fan-out via the SFU.** `publishData` with no destinations broadcasts to the
  whole room, so each client's `Y.Doc` converges directly and no manual relay is
  needed.
* **Python agent = anchor.** The `@platejs/yjs` logic in each client performs the
  CRDT merge. The agent listens for deltas, persists an append-only log per room,
  and when a participant joins, replays every stored delta to that one
  participant so its fresh document converges (Yjs updates are an append-only,
  idempotent CRDT).
* **Integration point.** `LiveKitProviderWrapper` self-registers via
  `registerProviderType('livekit', ...)` and plugs into `YjsPlugin` exactly like
  the built-in `hocuspocus`/`webrtc`/`indexeddb` providers.

## Prerequisites

* Node 18+ (client) and `uv` (Python; or `python3 -m venv` + `pip`)
* A LiveKit server. Either:
  * **Self-hosted:** `docker run --rm -p 7880:7880 -e LIVEKIT_KEYS="devkey: secret" livekit/livekit-server`, or
  * **LiveKit Cloud** project (URL is `wss://...`).

## Run it

Set credentials. Copy `.env.example` to the places that need it (the server,
agent, and client all read environment):

```bash
export LIVEKIT_URL=ws://localhost:7880      # or your cloud wss:// URL
export LIVEKIT_API_KEY=devkey
export LIVEKIT_API_SECRET=secret
```

### 1. Token server (FastAPI)

```bash
cd server
uv venv && uv pip install -r requirements.txt
LIVEKIT_URL=$LIVEKIT_URL LIVEKIT_API_KEY=$LIVEKIT_API_KEY \
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET \
  .venv/bin/uvicorn main:app --reload --port 8000
```

`GET http://localhost:8000/token?room=demo&username=alice` returns
`{ token, wsUrl, room }`. It also auto-dispatches the `plate-yjs` agent via room
configuration (disable with `PLATE_AGENT_NAME=`).

### 2. Agents worker (Yjs anchor)

```bash
cd agent
uv venv && uv pip install -r requirements.txt
LIVEKIT_URL=$LIVEKIT_URL LIVEKIT_API_KEY=$LIVEKIT_API_KEY \
LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET \
  .venv/bin/python -m livekit.agents.cli start
```

### 3. Client

```bash
cd client
npm install
npm run dev          # http://localhost:5173
```

Open the page in two tabs (or two browsers, sharing the same room ID) and type
in one — the other updates live. Cursors sync too. The default backend URL is
`http://localhost:8000`; override with `VITE_BACKEND_URL`.

## Directory layout

```
client/   Vite + React + platejs. LiveKitProvider.ts (the transport), App.tsx,
          token.ts (fetch from /token)
server/   FastAPI token issuer (livekit-api AccessToken) + CORS + /token /health
agent/    LiveKit Agents worker: per-room append-only update log, persistence
          to store/*.json, backfill of late joiners.
```
