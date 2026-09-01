import { registerProviderType } from '@platejs/yjs';
import type {
  ProviderEventHandlers,
  UnifiedProvider,
  YjsProviderType,
} from '@platejs/yjs';
import {
  Room,
  RoomEvent,
  type DataPacket_Kind,
  type RemoteParticipant,
} from 'livekit-client';
import * as Y from 'yjs';
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from 'y-protocols/awareness';

/**
 * Single LiveKit data topic used for all collaborative traffic. Each payload
 * begins with a one-byte protocol tag (see below) so we can distinguish update
 * vs awareness packets without depending on LiveKit's per-version topic support
 * in the `DataReceived` event.
 */
export const LIVEKIT_TOPIC = 'plate-yjs';

/** Protocol tag: followed by a raw Yjs update. */
const TAG_UPDATE = 0x01;
/** Protocol tag: followed by a y-protocols awareness update. */
const TAG_AWARENESS = 0x02;

export interface LiveKitProviderOptions {
  /**
   * LiveKit WebSocket URL, e.g. `wss://my-project.livekit.cloud`.
   */
  url: string;
  /**
   * A valid LiveKit access token for the room, typically fetched from the
   * FastAPI `/token` endpoint.
   */
  token: string;
  /**
   * LiveKit room name. Must match the room granted by the token.
   */
  roomName: string;
  /**
   * Optional pre-created `Room()` to reuse (e.g. to co-locate audio/video).
   */
  room?: Room;
  /**
   * Flush interval (ms) for batching rapid Yjs updates. LiveKit reliable
   * packets are capped at ~15KiB, so bursts are coalesced.
   *
   * @default 16
   */
  batchInterval?: number;
  /**
   * Set to `false` to send every Yjs update as its own packet instead of
   * coalescing a burst into a single `Y.mergeUpdates` packet.
   *
   * @default true
   */
  batch?: boolean;
}

/**
 * A transport for Plate's `@platejs/yjs` plugin that carries Yjs CRDT updates
 * and y-protocols awareness (cursors) over LiveKit data packets.
 *
 * The browser joins a LiveKit room as a participant (no audio/video). Every
 * local Yjs update is coalesced and published as a *reliable* data packet on a
 * single topic. Remote packets are applied to the shared `Y.Doc`. A LiveKit
 * Agents worker (the Python backend) stays in the room as the authority: it
 * applies every update to its own `Y.Doc`, persists the document, and relays
 * updates it did not originate back to the room — which is what backfills
 * updates to late joiners.
 *
 * LiveKit does not expose raw `RTCPeerConnection.createDataChannel`, so we use
 * its message-based data packet API rather than the `y-websocket` or `y-webrtc`
 * protocols.
 */
export class LiveKitProviderWrapper implements UnifiedProvider {
  private _isConnected = false;
  private _isSynced = false;
  private _isConnecting = false;

  private readonly doc: Y.Doc;
  private readonly room: Room;
  private readonly options: LiveKitProviderOptions;
  private readonly onSyncChange?: (isSynced: boolean) => void;
  private readonly onError: (error: Error) => void;
  private readonly onDisconnect?: () => void;
  private readonly onConnect?: () => void;

  private _awareness: Awareness;
  private localIdentity: string | null = null;
  private pendingBatch: Uint8Array[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  type: YjsProviderType = 'livekit';

  constructor({
    awareness,
    doc,
    options,
    onConnect,
    onDisconnect,
    onError,
    onSyncChange,
  }: {
    options: LiveKitProviderOptions;
    awareness?: Awareness;
    doc?: Y.Doc;
  } & ProviderEventHandlers) {
    this.doc = doc ?? new Y.Doc();
    this.options = options;
    this.onConnect = onConnect;
    this.onDisconnect = onDisconnect;
    this.onSyncChange = onSyncChange;
    this.onError = onError ?? (() => {});

    this._awareness = awareness ?? new Awareness(this.doc as unknown as Y.Doc);

    this.room = options.room ?? new Room();
    this.registerRoomHandlers();
    this.doc.on('update', this.onLocalUpdate);
    this._awareness.on('update', this.onLocalAwarenessUpdate);

    // Make the `livekit` provider type available to Plate's @platejs/yjs
    // plugin without requiring the consuming app to wire the registry itself.
    registerProviderType('livekit', LiveKitProviderWrapper as any);
  }

  /**
   * Update the LiveKit connection details before `connect()`. Useful when the
   * access token is fetched asynchronously before the provider is connected.
   */
  setCredentials(url: string, token: string) {
    this.options.url = url;
    this.options.token = token;
  }

  connect = () => {
    if (this.disposed) return;
    if (this._isConnected || this._isConnecting) return;

    this._isConnecting = true;
    this.room
      .connect(this.options.url, this.options.token)
      .then(() => {
        this._isConnecting = false;
        this.onConnected();
      })
      .catch((error) => {
        this._isConnecting = false;
        this.onError(
          error instanceof Error ? error : new Error(String(error))
        );
      });
  };

  disconnect = () => {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.room.disconnect();
    const wasSynced = this._isSynced;
    this._isConnected = false;
    this._isSynced = false;
    if (wasSynced) this.onSyncChange?.(false);
  };

  destroy = () => {
    this.disposed = true;
    this.doc.off('update', this.onLocalUpdate);
    this._awareness.off('update', this.onLocalAwarenessUpdate);
    this.disconnect();
  };

  get awareness(): Awareness {
    return this._awareness;
  }

  get document() {
    return this.doc;
  }
  get isConnected() {
    return this._isConnected;
  }
  get isSynced() {
    return this._isSynced;
  }
  get isConnectionPending() {
    return this._isConnecting;
  }

  private onConnected = () => {
    const wasConnected = this._isConnected;
    this._isConnected = true;
    this.localIdentity = this.room.localParticipant?.identity ?? null;

    // Announce our awareness so pre-existing peers see us immediately.
    this.publishAwareness();

    if (!wasConnected) this.onConnect?.();
    if (!this._isSynced) {
      this._isSynced = true;
      this.onSyncChange?.(true);
    }
    if (this.pendingBatch.length > 0) this.scheduleFlush(0);
  };

  private registerRoomHandlers() {
    this.room.on(
      RoomEvent.DataReceived,
      (
        payload: Uint8Array,
        participant: RemoteParticipant | undefined,
        _kind?: DataPacket_Kind,
        topic?: string
      ) => {
        // Only handle our collaboration topic (ignores unrelated data the room
        // may carry, e.g. chat or audio-control messages).
        if (topic && topic !== LIVEKIT_TOPIC) return;
        if (!participant) return;
        const senderId = participant.identity;
        if (senderId === this.localIdentity) return;
        this.applyRemotePayload(payload);
      }
    );

    this.room.on(RoomEvent.ParticipantConnected, (participant) => {
      if (participant.identity === this.localIdentity) return;
      // A peer just joined — give them our current awareness immediately.
      this.publishAwareness();
    });

    this.room.on(RoomEvent.Disconnected, () => {
      const wasConnected = this._isConnected;
      this._isConnected = false;
      if (wasConnected) {
        this.onDisconnect?.();
        if (this._isSynced) {
          this._isSynced = false;
          this.onSyncChange?.(false);
        }
      }
    });

    this.room.on(RoomEvent.Reconnected, () => {
      this._isConnected = true;
      this.publishAwareness();
    });
  }

  private applyRemotePayload = (payload: Uint8Array) => {
    if (payload.byteLength === 0) return;
    const tag = payload[0];
    const body = payload.subarray(1);
    try {
      if (tag === TAG_UPDATE) {
        // Pass `this` as the origin so `onLocalUpdate` skips re-publishing
        // updates that arrived from the network (echo/loop guard).
        Y.applyUpdate(this.doc, body, this);
      } else if (tag === TAG_AWARENESS) {
        applyAwarenessUpdate(this._awareness, body, this);
      }
    } catch (error) {
      this.onError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  };

  private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this) return; // echo guard
    this.pendingBatch.push(update);
    this.scheduleFlush(this.options.batchInterval ?? 16);
  };

  private scheduleFlush = (delay: number) => {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBatch();
    }, delay);
  };

  private flushBatch = () => {
    if (this.pendingBatch.length === 0) return;
    const batch = this.pendingBatch;
    this.pendingBatch = [];

    let update: Uint8Array;
    if (this.options.batch === false || batch.length === 1) {
      update = batch[0];
    } else {
      update = Y.mergeUpdates(batch);
    }
    this.publish(TAG_UPDATE, update);
  };

  private onLocalAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === this) return;
    if (changes.added.length === 0 &&
        changes.updated.length === 0 &&
        changes.removed.length === 0) return;
    if (!this._isConnected) return;
    this.publishAwareness();
  };

  private publishAwareness = () => {
    if (!this._isConnected || !this.room.localParticipant) return;
    const states = Array.from(this.awareness.getStates().keys());
    if (states.length === 0) return;
    try {
      const encoded = encodeAwarenessUpdate(this.awareness, states);
      this.publish(TAG_AWARENESS, encoded);
    } catch {
      /* best-effort */
    }
  };

  private publish = (tag: number, payload: Uint8Array) => {
    if (!this._isConnected || !this.room.localParticipant) return;
    const framed = new Uint8Array(payload.byteLength + 1);
    framed[0] = tag;
    framed.set(payload, 1);
    try {
      this.room.localParticipant.publishData(framed, {
        reliable: true,
        topic: LIVEKIT_TOPIC,
      } as any);
    } catch (error) {
      this.onError(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  };
}
