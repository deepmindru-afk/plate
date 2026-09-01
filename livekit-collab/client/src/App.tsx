import * as React from 'react';
import {
  Plate,
  PlateContent,
  usePlateEditor,
  usePluginOption,
} from 'platejs/react';
import {
  BaseBasicBlocksPlugin,
  BaseBasicMarksPlugin,
  BaseBoldPlugin,
  BaseItalicPlugin,
} from '@platejs/basic-nodes';
import { YjsPlugin } from '@platejs/yjs/react';
import type { UnifiedProvider } from '@platejs/yjs';

import { LiveKitProviderWrapper } from './LiveKitProvider';
import { fetchJoinToken, type TokenResponse } from './token';

const INITIAL_VALUE = [
  {
    type: 'p',
    children: [{ text: 'Edits here sync live over LiveKit. Open a second tab!' }],
  },
];

const BACKEND_BASE = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000';
const DEFAULT_ROOM = 'demo-room';

let counter = 0;
const nextUsername = () => `user-${++counter}`;

export function App() {
  const [roomName, setRoomName] = React.useState(DEFAULT_ROOM);
  const [error, setError] = React.useState<string | null>(null);

  // Fetch credentials once per room before creating the editor, so the provider
  // is constructed with a valid LiveKit URL + token.
  const [auth, setAuth] = React.useState<TokenResponse | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setAuth(null);
    setError(null);
    fetchJoinToken(BACKEND_BASE, roomName, nextUsername())
      .then((res) => {
        if (!cancelled) setAuth(res);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [roomName]);

  const editor = usePlateEditor({
    plugins: [
      BaseBasicBlocksPlugin,
      BaseBasicMarksPlugin,
      BaseBoldPlugin,
      BaseItalicPlugin,
      YjsPlugin.configure({
        options: {
          cursors: { data: { name: nextUsername() } },
          providers: [
            {
              type: 'livekit',
              options: {
                url: auth?.url ?? '',
                token: auth?.token ?? '',
                roomName,
              },
            } as any,
          ],
        },
      }),
    ],
    skipInitialization: true,
  });

  const providers = usePluginOption(YjsPlugin, '_providers');
  const isConnected = usePluginOption(YjsPlugin, '_isConnected');

  React.useEffect(() => {
    if (!auth) return;
    let cancelled = false;
    editor
      .getApi(YjsPlugin)
      .yjs.init({ id: roomName, autoSelect: 'end', value: INITIAL_VALUE })
      .then(() => {
        if (!cancelled) {
          // ensure the concrete provider holds the credentials in case they
          // were injected after construction.
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
      editor.getApi(YjsPlugin).yjs.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth, roomName]);

  const connect = async () => {
    if (!auth) return;
    const livekit = providers.find(
      (p: UnifiedProvider) => p.type === 'livekit'
    ) as LiveKitProviderWrapper | undefined;
    livekit?.setCredentials(auth.url, auth.token);
    livekit?.connect();
  };

  const disconnect = () => {
    editor.getApi(YjsPlugin).yjs.disconnect('livekit');
  };

  return (
    <div>
      <div className="toolbar">
        <span className="status">
          <span className={`dot ${isConnected ? 'connected' : 'disconnected'}`} />
          {isConnected ? 'LiveKit connected' : 'disconnected'}
        </span>
        <input
          value={roomName}
          onChange={(e) => setRoomName(e.target.value)}
          placeholder="Room ID"
          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #ccc' }}
        />
        <button disabled={!auth || isConnected} onClick={connect}>
          Connect
        </button>
        <button disabled={!isConnected} onClick={disconnect}>
          Disconnect
        </button>
        {error && <span style={{ color: '#dc2626', marginLeft: 8 }}>{error}</span>}
      </div>

      <Plate editor={editor}>
        <div className="editor-shell">
          <PlateContent placeholder="Type something…" />
        </div>
      </Plate>
    </div>
  );
}
