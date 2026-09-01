export interface TokenResponse {
  token: string;
  url: string;
  room: string;
}

/**
 * Fetch a join token for a room from the FastAPI backend.
 *
 * @param backendBase Base URL of the FastAPI server, e.g. http://localhost:8000
 * @param roomName    The document/room to join.
 * @param username    Optional display name carried in the token.
 */
export async function fetchJoinToken(
  backendBase: string,
  roomName: string,
  username: string
): Promise<TokenResponse> {
  const url = `${backendBase.replace(/\/$/, '')}/token?room=${encodeURIComponent(
    roomName
  )}&username=${encodeURIComponent(username)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Token request failed (${res.status}): ${detail}`);
  }
  const body = (await res.json()) as {
    token: string;
    wsUrl: string;
    room: string;
  };
  return { token: body.token, url: body.wsUrl, room: body.room };
}
