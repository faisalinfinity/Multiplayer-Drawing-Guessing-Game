import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { INGRESS_BURST, socketClientAddress } from './limits.js';
import { MongoClient } from 'mongodb';
import { io, type Socket } from 'socket.io-client';
import type { Ack, Command, DrawingEvent, PlayerIdentity, PrivateState, PublicRoom, Snapshot } from '@doodle/shared';
import { buildServer } from './app.js';

const mongoBase = process.env.MONGO_TEST_URI;
const allowedOrigin = 'http://localhost:3000';
type Server = Awaited<ReturnType<typeof buildServer>>;
interface Guest { player: PlayerIdentity; cookie: string }
interface Peer extends Guest { socket: Socket; state: PublicRoom; private: PrivateState; drawing: DrawingEvent[]; publicMessages: unknown[] }

async function until(predicate: () => unknown, message: string, timeout = 6_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 15));
  }
}

const stroke = (turnId: string): Command => ({ type: 'draw', turnId, op: { type: 'stroke', strokeId: 'integration-stroke', index: 0, tool: 'pen', color: '#25243a', size: 8, points: [{ x: 120, y: 120 }, { x: 360, y: 260 }], end: true } });

/** These tests intentionally use real journaled MongoDB writes and actual Socket.IO transports. */
describe.skipIf(!mongoBase)('HTTP / Socket.IO / MongoDB integration', () => {
  let server: Server | undefined;
  let base: string;
  let mongoUri: string;
  let peers: Peer[];
  let cleanupClient: MongoClient;

  const start = async () => {
    server = await buildServer({ mongoUri, origin: allowedOrigin, logger: false });
    base = await server.app.listen({ host: '127.0.0.1', port: 0 });
  };

  beforeEach(async () => {
    const uri = new URL(mongoBase!);
    uri.pathname = `/doodle_integration_${randomUUID().replaceAll('-', '')}`;
    mongoUri = uri.toString();
    peers = [];
    cleanupClient = new MongoClient(mongoUri);
    await cleanupClient.connect();
    await start();
  });

  afterEach(async () => {
    for (const peer of peers) peer.socket.disconnect();
    await server?.close();
    await cleanupClient.db().dropDatabase();
    await cleanupClient.close();
  });

  const session = async (name: string): Promise<Guest> => {
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: allowedOrigin }, body: JSON.stringify({ name, avatar: 0 }) });
    expect(response.status).toBeLessThan(300);
    const payload = await response.json() as { player: PlayerIdentity };
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    expect(cookie).toBeTruthy();
    return { player: payload.player, cookie: cookie! };
  };

  const connect = async (guest: Guest, roomId: string): Promise<Peer> => {
    const socket = io(base, { auth: { roomId }, transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: { Cookie: guest.cookie, Origin: allowedOrigin } });
    const peer = { player: guest.player, cookie: guest.cookie, socket, private: {}, drawing: [], publicMessages: [] } as unknown as Peer;
    let failure: Error | undefined;
    socket.on('connect_error', error => { failure = error; });
    socket.on('snapshot', (snapshot: Snapshot) => {
      peer.state = snapshot.state;
      peer.private = snapshot.private;
      peer.drawing = snapshot.drawing;
      peer.publicMessages.push(snapshot.state);
    });
    socket.on('state', (update: { state: PublicRoom }) => { peer.state = update.state; peer.publicMessages.push(update.state); });
    socket.on('private', (privateState: PrivateState) => { peer.private = privateState; });
    socket.on('drawing', (event: DrawingEvent) => {
      if (!peer.drawing.some(existing => existing.commandId === event.commandId)) peer.drawing.push(event);
    });
    peers.push(peer);
    socket.connect();
    await until(() => peer.state || failure, 'authenticated room snapshot');
    if (failure) throw failure;
    return peer;
  };

  const command = async (peer: Peer, value: Command | Record<string, unknown>, id = randomUUID()): Promise<Ack> => {
    return await peer.socket.timeout(6_000).emitWithAck('command', { id, command: value }) as Ack;
  };

  const room = async () => {
    const guests = await Promise.all(['Host', 'River', 'Sunny'].map(session));
    const response = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { cookie: guests[0]!.cookie, origin: allowedOrigin, 'content-type': 'application/json' }, body: '{}' });
    expect(response.status).toBeLessThan(300);
    const { roomId } = await response.json() as { roomId: string };
    const joined: Peer[] = [];
    for (const guest of guests) joined.push(await connect(guest, roomId));
    await until(() => joined.every(peer => peer.state.players.filter(player => player.connected).length === 3), 'all players present');
    const host = joined[0]!;
    expect((await command(host, { type: 'settings', settings: { rounds: 1, drawSeconds: 80, wordMode: 'custom', customWords: ['elephant', 'rainbow', 'guitar'] } })).ok).toBe(true);
    expect((await command(host, { type: 'start' })).ok).toBe(true);
    await until(() => joined.every(peer => peer.state.phase === 'choosing'), 'choosing phase');
    const drawer = joined.find(peer => peer.player.id === host.state.turn!.drawerId)!;
    const guessers = joined.filter(peer => peer !== drawer);
    await until(() => drawer.private.choices?.length === 3, 'private choices');
    const word = drawer.private.choices![0]!;
    const turnId = drawer.state.turn!.id;
    return { joined, guests, host, drawer, guessers, word, turnId, roomId };
  };

  const choose = async (drawer: Peer, turnId: string) => {
    expect((await command(drawer, { type: 'choose', turnId, index: 0 })).ok).toBe(true);
    await until(() => drawer.state.phase === 'drawing' && Boolean(drawer.private.word), 'drawing begins');
  };

  it('keeps words private, synchronizes late joins, and awards a correct guess exactly once', async () => {
    const game = await room();
    const [guesser, other] = game.guessers as [Peer, Peer];
    for (const peer of game.guessers) {
      expect(peer.private.choices).toBeUndefined();
      expect(peer.private.word).toBeUndefined();
      expect(JSON.stringify(peer.publicMessages)).not.toContain(game.word);
    }
    await choose(game.drawer, game.turnId);
    expect((await command(game.drawer, { type: 'guess', text: game.word, turnId: game.turnId })).ok).toBe(false);
    const drawId = randomUUID();
    const drawAck = await command(game.drawer, stroke(game.turnId), drawId);
    expect(drawAck.ok).toBe(true);
    await until(() => other.drawing.some(event => event.commandId === drawId), 'remote stroke arrival');
    const late = await connect(await session('Late visitor'), game.roomId);
    expect(late.drawing.map(event => event.commandId)).toContain(drawId);
    expect(late.state.turn?.eligibleIds).not.toContain(late.player.id);
    expect((await command(late, { type: 'guess', text: game.word, turnId: game.turnId })).code).toBe('SPECTATOR');
    const near = `${game.word.slice(0, -1)}${game.word.endsWith('x') ? 'z' : 'x'}`;
    expect((await command(guesser, { type: 'guess', text: near, turnId: game.turnId })).feedback).toBe('close');
    expect(JSON.stringify(other.publicMessages)).not.toContain('"feedback":"close"');
    const guessId = randomUUID();
    const award = await command(guesser, { type: 'guess', text: game.word.toUpperCase(), turnId: game.turnId }, guessId);
    expect(award.feedback).toBe('correct');
    expect(award.points).toBeGreaterThan(100);
    const duplicate = await command(guesser, { type: 'guess', text: game.word.toUpperCase(), turnId: game.turnId }, guessId);
    expect(duplicate).toEqual(award);
    expect(guesser.state.players.find(player => player.id === guesser.player.id)?.score).toBe(award.points);
    expect(guesser.state.players.find(player => player.id === game.drawer.player.id)?.score).toBe(50);
    expect((await command(guesser, { type: 'guess', text: game.word, turnId: game.turnId })).code).toBe('CHAT_LOCKED');
    expect(other.state.chat.filter(message => message.kind === 'chat').map(message => message.text)).not.toContain(game.word);
    expect(JSON.stringify(other.state)).not.toContain(`"word":"${game.word}"`);
    expect((await command(other, { type: 'guess', text: game.word, turnId: game.turnId })).feedback).toBe('correct');
    await until(() => other.state.phase === 'reveal', 'all eligible guessers end turn');
    expect(other.state.turn?.revealedWord).toBe(game.word);
    expect(other.state.players.find(player => player.id === game.drawer.player.id)?.score).toBe(100);
  });

  it('rejects forged roles, stale turns, unexpected fields and invalid drawing coordinates', async () => {
    const game = await room();
    const intruder = game.guessers[0]!;
    expect((await command(intruder, { type: 'choose', turnId: game.turnId, index: 0 })).code).toBe('FORBIDDEN');
    expect((await command(intruder, { type: 'settings', settings: { rounds: 10, drawSeconds: 15, wordMode: 'builtin', customWords: [] } })).ok).toBe(false);
    await choose(game.drawer, game.turnId);
    expect((await command(intruder, stroke(game.turnId))).ok).toBe(false);
    expect((await command(game.drawer, stroke('old-turn'))).ok).toBe(false);
    expect((await command(intruder, { type: 'guess', text: 'anything', points: 999999 })).ok).toBe(false);
    const invalid = stroke(game.turnId) as Extract<Command, { type: 'draw' }>;
    expect((await command(game.drawer, { ...invalid, op: { ...invalid.op, points: [{ x: 800, y: -1 }] } })).ok).toBe(false);
    expect((await command(intruder, { type: 'guess', text: 'x'.repeat(201) })).ok).toBe(false);
    expect(game.host.state.players.every(player => player.score === 0)).toBe(true);
    expect(game.drawer.drawing).toHaveLength(0);
  });

  it('reconnects the same guest with their score and canvas kept', async () => {
    const game = await room();
    await choose(game.drawer, game.turnId);
    const guesser = game.guessers[0]!;
    expect((await command(game.drawer, stroke(game.turnId))).ok).toBe(true);
    const award = await command(guesser, { type: 'guess', text: game.word, turnId: game.turnId });
    guesser.socket.disconnect();
    await until(() => game.drawer.state.players.find(player => player.id === guesser.player.id)?.connected === false, 'disconnect persisted');
    const resumed = await connect(guesser, game.roomId);
    expect(resumed.state.players.filter(player => player.id === guesser.player.id)).toHaveLength(1);
    expect(resumed.state.players.find(player => player.id === guesser.player.id)?.score).toBe(award.points);
    expect(resumed.state.players.find(player => player.id === guesser.player.id)?.guessed).toBe(true);
    expect(resumed.drawing).toHaveLength(1);
    expect((await command(resumed, { type: 'guess', text: game.word, turnId: game.turnId })).code).toBe('CHAT_LOCKED');
  });

  it('recovers an acknowledged score and drawing across a server restart without double awards', async () => {
    const game = await room();
    await choose(game.drawer, game.turnId);
    const guesser = game.guessers[0]!;
    const drawId = randomUUID();
    const drawAck = await command(game.drawer, stroke(game.turnId), drawId);
    expect(drawAck.ok).toBe(true);
    const guessId = randomUUID();
    const award = await command(guesser, { type: 'guess', text: game.word, turnId: game.turnId }, guessId);
    expect(award.ok).toBe(true);
    expect(await server!.store.journal.countDocuments({ roomId: game.roomId, actorId: game.drawer.player.id, commandId: drawId })).toBe(1);
    const deadline = game.drawer.state.turn!.deadline;
    for (const peer of game.joined) peer.socket.disconnect();
    await server!.close();
    server = undefined;
    await start();
    const resumed = await connect(guesser, game.roomId);
    expect(resumed.state.turn?.id).toBe(game.turnId);
    expect(resumed.state.turn?.deadline).toBe(deadline);
    expect(resumed.state.players.find(player => player.id === guesser.player.id)?.score).toBe(award.points);
    expect(resumed.drawing.some(event => event.commandId === drawId && event.seq === drawAck.seq)).toBe(true);
    expect(resumed.private.word).toBeUndefined();
    expect(await command(resumed, { type: 'guess', text: game.word, turnId: game.turnId }, guessId)).toEqual(award);
    expect(await server!.store.journal.countDocuments({ roomId: game.roomId, actorId: guesser.player.id, commandId: guessId })).toBe(1);
    const resumedDrawer = await connect(game.drawer, game.roomId);
    expect(resumedDrawer.private.word).toBe(game.word);
    expect(await command(resumedDrawer, stroke(game.turnId), drawId)).toEqual(drawAck);
    expect(await server!.store.journal.countDocuments({ roomId: game.roomId, actorId: game.drawer.player.id, commandId: drawId })).toBe(1);
  });

  it('rejects untrusted origins and unauthenticated socket connections', async () => {
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Visitor', avatar: 0 }) });
    expect(response.status).toBe(403);
    const guest = await session('Host');
    const created = await fetch(`${base}/api/rooms`, { method: 'POST', headers: { cookie: guest.cookie, origin: allowedOrigin, 'content-type': 'application/json' }, body: '{}' });
    const { roomId } = await created.json() as { roomId: string };
    const rejectedHeaders: Record<string, string>[] = [{ Origin: allowedOrigin }, { Origin: 'https://untrusted.example', Cookie: guest.cookie }];
    for (const headers of rejectedHeaders) {
      const socket = io(base, { auth: { roomId }, transports: ['websocket'], reconnection: false, autoConnect: false, extraHeaders: headers });
      try {
        const rejected = new Promise<Error>(resolve => socket.once('connect_error', resolve));
        socket.connect();
        expect(await rejected).toBeInstanceOf(Error);
        expect(socket.connected).toBe(false);
      } finally { socket.disconnect(); }
    }
  });

  it('reconciles a database write whose acknowledgement was lost', async () => {
    const game = await room();
    await choose(game.drawer, game.turnId);
    const insert = server!.store.journal.insertOne.bind(server!.store.journal);
    const fault = vi.spyOn(server!.store.journal, 'insertOne').mockImplementationOnce(async (document, options) => {
      await insert(document, options);
      throw new Error('Simulated connection loss after the database committed');
    });
    try {
      const id = randomUUID();
      const ack = await command(game.drawer, stroke(game.turnId), id);
      expect(ack.ok).toBe(true);
      await until(() => game.guessers[0]!.drawing.some(event => event.commandId === id), 'snapshot repairs uncertain write');
      expect(await command(game.drawer, stroke(game.turnId), id)).toEqual(ack);
      expect(await server!.store.journal.countDocuments({ roomId: game.roomId, commandId: id })).toBe(1);
    } finally { fault.mockRestore(); }
  });

  it('disconnects oversized socket packets and rejects oversized HTTP bodies', async () => {
    const game = await room();
    await choose(game.drawer, game.turnId);
    const disconnected = new Promise<void>(resolve => game.guessers[0]!.socket.once('disconnect', () => resolve()));
    game.guessers[0]!.socket.emit('command', { id: randomUUID(), command: { type: 'guess', text: 'x'.repeat(20_000) } });
    await disconnected;
    expect(game.guessers[0]!.socket.connected).toBe(false);
    const response = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: allowedOrigin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x'.repeat(20_000), avatar: 0 }) });
    expect(response.status).toBe(413);
    expect(game.host.state.players.every(player => player.score === 0)).toBe(true);
  });

  it('durably marks a disconnected transport offline after its original write fails', async () => {
    const game = await room();
    await choose(game.drawer, game.turnId);
    const victim = game.host;
    const observer = game.guessers[0]!;
    const insert = server!.store.journal.insertOne.bind(server!.store.journal);
    let failedDisconnect = false;
    const fault = vi.spyOn(server!.store.journal, 'insertOne').mockImplementation(async (document, options) => {
      if (!failedDisconnect && document.kind === 'state' && document.state?.players.find(player => player.id === victim.player.id)?.connected === false) {
        failedDisconnect = true;
        throw new Error('Storage unavailable before disconnect was committed');
      }
      return insert(document, options);
    });
    try {
      const droppedAt = Date.now();
      victim.socket.disconnect();
      await until(() => failedDisconnect, 'disconnect write fault');
      await until(() => observer.state.players.find(player => player.id === victim.player.id)?.connected === false, 'recovery removes the phantom connection');
      const persisted = await server!.store.load(game.roomId);
      const offline = persisted!.state.players.find(player => player.id === victim.player.id)!;
      expect(offline.connected).toBe(false);
      expect(offline.disconnectedAt).toBeGreaterThanOrEqual(droppedAt);
      expect(offline.disconnectedAt).toBeLessThan(droppedAt + 1000);
      expect(persisted!.state.turn?.id).toBe(game.turnId);
      expect(persisted!.state.players.filter(player => player.connected)).toHaveLength(2);
    } finally { fault.mockRestore(); }
  });

  it.each(['invalid', 'cached'] as const)('bounds %s command bursts before parsing or cached acknowledgements', async kind => {
    const game = await room();
    const sender = game.guessers[0]!;
    const id = randomUUID();
    const value: Command = { type: 'guess', text: 'ordinary lobby chat' };
    if (kind === 'cached') expect((await command(sender, value, id)).ok).toBe(true);
    const disconnected = new Promise<void>(resolve => sender.socket.once('disconnect', () => resolve()));
    for (let index = 0; index < INGRESS_BURST + 100; index++) {
      sender.socket.emit('command', kind === 'cached' ? { id, command: value } : { invalid: 'x'.repeat(1000) });
    }
    await disconnected;
    expect(sender.socket.connected).toBe(false);
    expect(await server!.store.journal.countDocuments({ roomId: game.roomId, actorId: sender.player.id, commandId: id })).toBe(kind === 'cached' ? 1 : 0);
    expect(game.host.socket.connected).toBe(true);
    expect(game.host.state.players.every(player => player.score === 0)).toBe(true);
  });

  it('retains completed participants replay access after lobby cleanup and enforces seven days if TTL cleanup failed', async () => {
    const game = await room();
    const gameId = game.host.state.gameId!;
    let ttlFault: ReturnType<typeof vi.spyOn> | undefined;
    try {
      for (let turn = 0; turn < 3; turn++) {
        await until(() => game.host.state.phase === 'choosing', 'next drawer');
        const drawer = game.joined.find(peer => peer.player.id === game.host.state.turn!.drawerId)!;
        await until(() => drawer.private.choices?.length === 3, 'drawer choices');
        const word = drawer.private.choices![0]!;
        const turnId = game.host.state.turn!.id;
        await choose(drawer, turnId);
        expect((await command(drawer, stroke(turnId))).ok).toBe(true);
        if (turn === 2) ttlFault = vi.spyOn(server!.store.journal, 'updateMany').mockRejectedValueOnce(new Error('TTL cleanup temporarily unavailable'));
        for (const guesser of game.joined.filter(peer => peer !== drawer)) {
          expect((await command(guesser, { type: 'guess', turnId, text: word })).feedback).toBe('correct');
        }
        await until(() => game.host.state.phase === (turn === 2 ? 'results' : 'choosing'), 'reveal completes');
      }
      expect(ttlFault).toHaveBeenCalledTimes(1);
      ttlFault?.mockRestore();
      ttlFault = undefined;
      const departed = game.guessers[0]!;
      expect((await command(departed, { type: 'leave' })).ok).toBe(true);
      expect((await command(game.host, { type: 'lobby' })).ok).toBe(true);
      await until(() => game.host.state.phase === 'lobby', 'return to lobby');
      expect(game.host.state.players.some(player => player.id === departed.player.id)).toBe(false);
      const replayUrl = `${base}/api/rooms/${game.roomId}/games/${gameId}`;
      const response = await fetch(replayUrl, { headers: { cookie: departed.cookie } });
      expect(response.status).toBe(200);
      const replay = await response.json() as { drawings: Array<{ turnId: string }> };
      expect(replay.drawings).toHaveLength(3);
      expect((await fetch(`${replayUrl}/turns/${replay.drawings[0]!.turnId}`, { headers: { cookie: departed.cookie } })).status).toBe(200);
      const stranger = await session('Outside visitor');
      expect((await fetch(replayUrl, { headers: { cookie: stranger.cookie } })).status).toBe(403);
      // Simulate the retention boundary while deliberately leaving TTL dates in the future.
      await server!.store.journal.updateMany({ roomId: game.roomId, gameId, 'effects.type': 'game-ended' }, { $set: { 'effects.$[ending].endedAt': Date.now() - 7 * 86400000 - 1 } }, { arrayFilters: [{ 'ending.type': 'game-ended' }] });
      expect(await server!.store.replay(game.roomId, gameId)).toBeNull();
      expect((await fetch(replayUrl, { headers: { cookie: game.host.cookie } })).status).toBe(404);
    } finally { ttlFault?.mockRestore(); }
  }, 30_000);

  it('permanently fails closed after monotonic lease expiry instead of silently reacquiring', async () => {
    const game = await room();
    const original = await server!.store.client.db().collection('leases').findOne({ name: 'game-server' });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 20_000);
    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(503);
    } finally { clock.mockRestore(); }
    expect(server!.store.hasLease()).toBe(false);
    expect(await server!.store.lease()).toBe(false);
    expect((await server!.store.client.db().collection('leases').findOne({ name: 'game-server' }))?.until).toEqual(original?.until);
    expect((await command(game.guessers[0]!, { type: 'guess', text: 'No mutation after expiry' })).code).toBe('RECOVERING');
    expect((await fetch(`${base}/api/rooms`, { method: 'POST', headers: { cookie: game.host.cookie, origin: allowedOrigin, 'content-type': 'application/json' }, body: '{}' })).status).toBe(503);
  });

  it('separates trusted gateway clients while ignoring untrusted forwarded addresses', async () => {
    expect(socketClientAddress('127.0.0.1', '203.0.113.20', false)).toBe('127.0.0.1');
    expect(socketClientAddress('127.0.0.1', 'spoofed, 203.0.113.20', true)).toBe('203.0.113.20');
    expect(socketClientAddress('127.0.0.1', 'not-an-ip', true)).toBe('127.0.0.1');
    await server!.close(); server = undefined;
    vi.stubEnv('TRUST_PROXY', 'true');
    vi.stubEnv('SOCKET_CONNECTION_RATE', '1');
    try {
      await start();
      const failure = async (address: string) => {
        const socket = io(base, { transports: ['websocket'], autoConnect: false, reconnection: false, extraHeaders: { Origin: allowedOrigin, 'X-Forwarded-For': address } });
        try {
          const error = new Promise<Error>(resolve => socket.once('connect_error', resolve));
          socket.connect();
          return (await error).message;
        } finally { socket.disconnect(); }
      };
      for (let index = 0; index < 6; index++) expect(await failure('203.0.113.20')).toContain('Choose your name');
      expect(await failure('203.0.113.20')).toContain('Too many connections');
      expect(await failure('203.0.113.21')).toContain('Choose your name');
    } finally { vi.unstubAllEnvs(); }
  });

  it('allows only one authoritative writer for a database', async () => {
    await expect(buildServer({ mongoUri, origin: allowedOrigin, logger: false })).rejects.toThrow();
  });
});
