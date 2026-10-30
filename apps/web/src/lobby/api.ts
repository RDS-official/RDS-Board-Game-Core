import type { HubGameInfo, HubRoomInfo } from '@rds/room-protocol';

const auth = () => ({ Authorization: 'Bearer ' + localStorage.getItem('token') });

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(path.startsWith('/api/auth') && !path.includes('me') ? {} : auth()), ...init.headers } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body as T;
}

export const getGames = () => api<HubGameInfo[]>('/api/games');
export const getRooms = () => api<HubRoomInfo[]>('/api/rooms');
export interface CreateRoomOpts { maxPlayers?: number; isPrivate?: boolean; scenarioId?: string; }
export const createRoom = (name: string, gameId: string, opts: CreateRoomOpts = {}) =>
  api<HubRoomInfo>('/api/rooms', { method: 'POST', body: JSON.stringify({ name, gameId, ...opts }) });
export const joinRoom = (id: string, code?: string) =>
  api<HubRoomInfo>('/api/rooms/' + id + '/join', { method: 'POST', body: JSON.stringify(code ? { code } : {}) });
export interface UserProfile { id: string; name: string; displayName: string; role?: 'admin' | 'user'; avatarUrl?: string; }
export const me = () => api<UserProfile>('/api/me');
export const updateDisplayName = (displayName: string) =>
  api<UserProfile>('/api/me', { method: 'PUT', body: JSON.stringify({ displayName }) });
/** 头像二进制直传（≤300KB，前端已压缩）；不用 api() 以避开 JSON Content-Type。 */
export async function uploadAvatar(blob: Blob): Promise<{ avatarUrl: string }> {
  const res = await fetch('/api/me/avatar', {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': blob.type || 'image/webp' },
    body: blob,
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body as { avatarUrl: string };
}
export const getRoom = (id: string) => api<HubRoomInfo>('/api/rooms/' + id);
export const leaveRoom = (id: string) => api<HubRoomInfo | { ok: true }>('/api/rooms/' + id + '/leave', { method: 'POST' });
export const setRoomStatus = (id: string, status: 'open' | 'playing' | 'closed') =>
  api<HubRoomInfo>('/api/rooms/' + id + '/status', { method: 'POST', body: JSON.stringify({ status }) });
// ---- Phase B ----
export const setReady = (id: string, ready: boolean) =>
  api<HubRoomInfo>('/api/rooms/' + id + '/ready', { method: 'POST', body: JSON.stringify({ ready }) });
export const kickPlayer = (id: string, target: string) =>
  api<HubRoomInfo>('/api/rooms/' + id + '/kick', { method: 'POST', body: JSON.stringify({ target }) });
export const transferHost = (id: string, target: string) =>
  api<HubRoomInfo>('/api/rooms/' + id + '/host', { method: 'POST', body: JSON.stringify({ target }) });
