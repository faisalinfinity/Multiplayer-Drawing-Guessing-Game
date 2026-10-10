'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { Ack, Command, DrawingEvent, PrivateState, PublicRoom, Snapshot } from '@doodle/shared';

export function useRoom(roomId: string, enabled: boolean) {
  const socket = useRef<Socket | null>(null);
  const stateRef = useRef<PublicRoom | null>(null);
  const eventsRef = useRef<DrawingEvent[]>([]);
  const syncPending = useRef(false);
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [privateState, setPrivateState] = useState<PrivateState>({});
  const [events, setEvents] = useState<DrawingEvent[]>([]);
  const [playerId, setPlayerId] = useState('');
  const [connected, setConnected] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [kicked, setKicked] = useState(false);
  const sync = useCallback(() => { syncPending.current = true; socket.current?.emit('sync'); }, []);

  useEffect(() => {
    if (!enabled) return;
    const client = io(process.env.NEXT_PUBLIC_SOCKET_URL || undefined, { path: '/socket.io', auth: { roomId }, withCredentials: true, transports: ['websocket', 'polling'], reconnectionDelay: 500, reconnectionDelayMax: 3000 });
    socket.current = client;
    client.on('connect', () => { setError(''); });
    client.on('disconnect', () => { setConnected(false); });
    client.on('connect_error', (err: Error) => { setConnected(false); setError(err.message || 'Connection interrupted. Reconnecting…'); });
    client.on('snapshot', (snapshot: Snapshot) => {
      if (stateRef.current && snapshot.state.version < stateRef.current.version) return;
      stateRef.current = snapshot.state; eventsRef.current = snapshot.drawing; syncPending.current = false;
      setRoom(snapshot.state); setEvents(snapshot.drawing); setPrivateState(snapshot.private); setPlayerId(snapshot.playerId); setOffset(snapshot.serverTime - Date.now()); setConnected(true); setError('');
    });
    client.on('state', ({ state, serverTime }: { state: PublicRoom; serverTime: number }) => {
      if (stateRef.current && state.version <= stateRef.current.version) return;
      if (state.turn?.id !== stateRef.current?.turn?.id) { eventsRef.current = []; setEvents([]); setPrivateState(previous => ({ ...(previous.customWords ? { customWords: previous.customWords } : {}) })); }
      stateRef.current = state; setRoom(state); setOffset(serverTime - Date.now());
    });
    client.on('private', (value: PrivateState) => setPrivateState(value));
    client.on('drawing', (event: DrawingEvent) => {
      if (event.turnId !== stateRef.current?.turn?.id) return;
      const previous = eventsRef.current;
      const last = previous.at(-1)?.seq || 0;
      if (event.seq <= last) return;
      if (event.seq !== last + 1) { if (!syncPending.current) sync(); return; }
      const next = [...previous, event]; eventsRef.current = next; setEvents(next);
    });
    client.on('status', (status: { recovering: boolean; message?: string }) => { setRecovering(status.recovering); if (status.recovering && status.message) setError(status.message); else setError(''); });
    client.on('kicked', () => { setKicked(true); setConnected(false); client.disconnect(); });
    return () => { client.disconnect(); socket.current = null; stateRef.current = null; eventsRef.current = []; };
  }, [roomId, enabled, sync]);

  const command = useCallback((value: Command, id = crypto.randomUUID()): Promise<Ack> => new Promise(resolve => {
    const client = socket.current;
    if (!client?.connected) { resolve({ ok: false, error: 'You’re reconnecting. Please try again in a moment.' }); return; }
    client.timeout(8000).emit('command', { id, command: value }, (err: Error | null, result: Ack) => {
      if (err) { sync(); resolve({ ok: false, code: 'ACK_TIMEOUT', error: 'The server is taking a moment. Refreshing the room…' }); }
      else resolve(result);
    });
  }), [sync]);
  return { room, privateState, events, playerId, connected, recovering, error, offset, kicked, command, sync };
}
