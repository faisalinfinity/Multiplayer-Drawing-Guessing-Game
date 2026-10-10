import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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

  it('allows only one authoritative writer for a database', async () => {
    await expect(buildServer({ mongoUri, origin: allowedOrigin, logger: false })).rejects.toThrow();
  });
});
