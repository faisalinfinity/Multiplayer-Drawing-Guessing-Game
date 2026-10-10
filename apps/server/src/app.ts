import Fastify, { LogController } from 'fastify';
import cookie from '@fastify/cookie';
import { Server, type Socket } from 'socket.io';
import { randomBytes, randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { commandSchema, identitySchema, type Ack, type DrawingEvent, type DrawingOp, type PlayerIdentity, type Snapshot } from '@doodle/shared';
import { createRoom, joinRoom, applyCommand, advance, disconnectPlayer, publicState, privateState, type EngineState, type EngineResult } from './engine.js';
import { GameStore, type JournalEntry } from './store.js';
import { TokenBuckets } from './limits.js';

interface Actor {
  state: EngineState; seq: number; drawing: DrawingEvent[]; bytes: number;
  queue: Promise<unknown>; pending: number; recovering: boolean; lastCheckpoint: number;
  receipts: Map<string, Ack>; sockets: Map<string, Socket>;
  stroke: { id: string; index: number; points: number; tool: string; color: string; size: number } | null;
  strokeIds: Set<string>;
}
export interface ServerOptions { mongoUri: string; origin?: string; logger?: boolean }
export async function buildServer(options: ServerOptions) {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 16384, trustProxy: process.env.TRUST_PROXY === 'true', logController: new LogController({ disableRequestLogging: true }) });
  await app.register(cookie);
  const origins = new Set((options.origin ?? process.env.ORIGIN ?? 'http://localhost:3000').split(','));
  const store = new GameStore(options.mongoUri);
  await store.connect();
  if (!await store.lease()) { await store.client.close(); throw new Error('Another game server owns this database. Run one authoritative instance.'); }
  const actors = new Map<string, Actor>();
  const limits = new TokenBuckets();
  let closing = false;
  let leaseHealthy = true;
  const metrics = { commands: 0, rejected: 0, drawingBatches: 0, durableMsTotal: 0, durableMsMax: 0, commits: 0 };
  const eventLoop = monitorEventLoopDelay({ resolution: 20 }); eventLoop.enable();
  const io = new Server(app.server, { maxHttpBufferSize: 16384, pingInterval: 10000, pingTimeout: 10000, serveClient: false,
    cors: { origin: [...origins], credentials: true },
    allowRequest: (request, callback) => callback(null, origins.has(request.headers.origin ?? '')),
  });
  const makeActor = (state: EngineState, seq = 0, drawing: DrawingEvent[] = []): Actor => ({ state, seq, drawing, bytes: Buffer.byteLength(JSON.stringify(drawing)), queue: Promise.resolve(), pending: 0, recovering: false, lastCheckpoint: 0, receipts: new Map(), sockets: new Map(), stroke: null, strokeIds: new Set(drawing.flatMap(e => e.op.type === 'stroke' ? [e.op.strokeId] : [])) });
  function enqueue<T>(actor: Actor, task: () => Promise<T>): Promise<T> {
    if (actor.pending >= 128) return Promise.reject(new Error('Room is busy. Please retry.'));
    actor.pending++;
    const next = actor.queue.then(task);
    actor.queue = next.catch(() => undefined).finally(() => { actor.pending--; });
    return next;
  }
  function snapshot(actor: Actor, playerId: string): Snapshot {
    return { state: publicState(actor.state), playerId, private: privateState(actor.state, playerId), drawing: actor.drawing, serverTime: Date.now() };
  }
  function publish(actor: Actor) {
    io.to(actor.state.id).emit('state', { state: publicState(actor.state), serverTime: Date.now() });
    for (const [id, socket] of actor.sockets) {
      socket.emit('private', privateState(actor.state, id));
      if (actor.state.bannedIds.includes(id)) { socket.emit('kicked', { message: 'The host removed you from this room.' }); socket.disconnect(true); }
    }
  }
  function unavailable(actor: Actor) {
    actor.recovering = true;
    io.to(actor.state.id).emit('status', { recovering: true, message: 'Connection to storage interrupted. Reconnecting safely…' });
  }
  async function recover(actor: Actor) {
    const loaded = await store.load(actor.state.id);
    if (!loaded) throw new Error('Room could not be restored');
    actor.state = loaded.state; actor.seq = loaded.seq; actor.drawing = loaded.drawing;
    actor.bytes = Buffer.byteLength(JSON.stringify(actor.drawing)); actor.stroke = null;
    actor.strokeIds = new Set(actor.drawing.flatMap(e => e.op.type === 'stroke' ? [e.op.strokeId] : []));
    actor.recovering = false;
    for (const [id, socket] of actor.sockets) socket.emit('snapshot', snapshot(actor, id));
    io.to(actor.state.id).emit('status', { recovering: false });
  }
  async function commit(actor: Actor, result: EngineResult, actorId = 'system', commandId: string = randomUUID()): Promise<Ack> {
    const ack: Ack = result.error ? { ok: false, code: result.error.code, error: result.error.message } : { ok: true, feedback: result.reply?.kind ?? 'ok', ...(result.reply?.points !== undefined ? { points: result.reply.points } : {}) };
    const changed = result.state !== actor.state;
    if (!changed && actorId === 'system') return ack;
    const seq = actor.seq + 1;
    const next = { ...result.state, version: seq };
    const previousTurn = actor.state.turn?.id;
    const entry: JournalEntry = { roomId: next.id, seq, actorId, commandId, kind: 'state', gameId: next.gameId ?? actor.state.gameId, turnId: next.turn?.id ?? null, at: Date.now(), expiresAt: new Date(Date.now() + 8 * 86400000), state: next, effects: result.effects, ack };
    const start = performance.now();
    const saved = await store.append(entry);
    if (!saved.inserted) {
      // Also repairs a successful write whose acknowledgement was lost.
      if (saved.entry.seq > actor.seq) await recover(actor);
      return saved.entry.ack;
    }
    const duration = performance.now() - start; metrics.commits++; metrics.durableMsTotal += duration; metrics.durableMsMax = Math.max(metrics.durableMsMax, duration);
    for (const effect of result.effects) if (effect.type === 'game-ended') {
      await store.journal.updateMany({ roomId: next.id, gameId: effect.gameId }, { $set: { expiresAt: new Date(effect.endedAt + 7 * 86400000) } });
    }
    actor.state = next; actor.seq = seq;
    if (previousTurn !== next.turn?.id) { actor.drawing = []; actor.bytes = 0; actor.stroke = null; actor.strokeIds.clear(); }
    if (changed) publish(actor);
    if (Date.now() - actor.lastCheckpoint > 30000 || result.effects.length > 0) {
      actor.lastCheckpoint = Date.now();
      // The journal is authoritative; a failed optimization never loses accepted events.
      try { await store.checkpoint(actor.state, actor.seq); } catch { app.log.warn({ roomId: next.id }, 'Checkpoint deferred; journal remains durable'); }
    }
    return ack;
  }
  async function draw(actor: Actor, playerId: string, commandId: string, turnId: string, op: DrawingOp, now: number): Promise<Ack> {
    await commit(actor, advance(actor.state, now));
    const turn = actor.state.turn;
    if (actor.state.phase !== 'drawing' || !turn || turn.id !== turnId || turn.drawerId !== playerId || now >= turn.deadline) return { ok: false, error: 'Only the current drawer can draw.', code: 'FORBIDDEN' };
    const size = Buffer.byteLength(JSON.stringify(op));
    if (size > 4096 || actor.bytes + size > 2 * 1024 * 1024) return { ok: false, error: 'Drawing limit reached for this turn.', code: 'DRAWING_LIMIT' };
    let nextStroke = actor.stroke;
    if (op.type === 'stroke') {
      if (!limits.take(`${playerId}:points`, 2000, 4000, op.points.length, now)) return { ok: false, error: 'Please draw a little slower.', code: 'RATE_LIMIT' };
      if (op.index === 0) {
        if (actor.strokeIds.has(op.strokeId)) return { ok: false, error: 'This stroke already exists.', code: 'STALE_STROKE' };
        nextStroke = { id: op.strokeId, index: 0, points: 0, tool: op.tool, color: op.color, size: op.size };
      }
      if (!nextStroke || nextStroke.id !== op.strokeId || nextStroke.index !== op.index || nextStroke.tool !== op.tool || nextStroke.color !== op.color || nextStroke.size !== op.size || nextStroke.points + op.points.length > 8192) return { ok: false, error: 'Stroke out of sequence. Please start a new stroke.', code: 'STROKE_ORDER' };
      nextStroke = op.end ? null : { ...nextStroke, index: op.index + 1, points: nextStroke.points + op.points.length };
    } else {
      if (!limits.take(`${playerId}:canvas-actions`, 2, 4, 1, now)) return { ok: false, error: 'Please wait before another canvas action.', code: 'RATE_LIMIT' };
      nextStroke = null;
    }
    const event: DrawingEvent = { seq: actor.drawing.length + 1, turnId, commandId, at: now, op };
    const ack: Ack = { ok: true, seq: event.seq };
    const entry: JournalEntry = { roomId: actor.state.id, seq: actor.seq + 1, actorId: playerId, commandId, kind: 'draw', gameId: actor.state.gameId, turnId, at: now, expiresAt: new Date(now + 8 * 86400000), drawing: event, ack };
    const start = performance.now();
    const saved = await store.append(entry);
    if (!saved.inserted) { if (saved.entry.seq > actor.seq) await recover(actor); return saved.entry.ack; }
    const duration = performance.now() - start; metrics.commits++; metrics.durableMsTotal += duration; metrics.durableMsMax = Math.max(metrics.durableMsMax, duration);
    actor.seq = entry.seq; actor.drawing.push(event); actor.bytes += size; actor.stroke = nextStroke;
    if (op.type === 'stroke') actor.strokeIds.add(op.strokeId);
    metrics.drawingBatches++;
    io.to(actor.state.id).emit('drawing', event);
    return ack;
  }
  for (const id of await store.roomIds()) {
    const loaded = await store.load(id);
    if (!loaded || Date.now() - loaded.state.lastActiveAt > 3600000) continue;
    const actor = makeActor(loaded.state, loaded.seq, loaded.drawing); actors.set(id, actor);
    // Mark all transports offline before advancing timers: no next turn may start for phantom connections.
    const restored = structuredClone(actor.state);
    const now = Date.now();
    for (const player of restored.players) if (!player.departed) { player.connected = false; player.disconnectedAt = now; }
    await commit(actor, { state: restored, effects: [] });
    await commit(actor, advance(actor.state, Date.now()));
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin && !origins.has(request.headers.origin)) return reply.code(403).send({ error: 'Origin not allowed' });
    if (request.method === 'POST' && !limits.take(`http:${request.ip}`, Number(process.env.HTTP_RATE ?? 5), Number(process.env.HTTP_RATE ?? 5) * 6)) return reply.code(429).send({ error: 'Too many requests. Please wait.' });
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  const playerFor = (request: { cookies: Record<string, string | undefined> }) => store.session(request.cookies.doodle_session);
  app.get('/api/health', async (_request, reply) => {
    if (!leaseHealthy || closing || [...actors.values()].some(a => a.recovering)) return reply.code(503).send({ ok: false });
    try { await store.client.db().command({ ping: 1 }); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });
  // Metrics are only exposed when explicitly enabled for local operations/load measurement.
  if (process.env.ENABLE_METRICS === 'true') app.get('/api/metrics', async () => ({ ...metrics, rooms: actors.size, connected: [...actors.values()].reduce((n, a) => n + a.sockets.size, 0), rss: process.memoryUsage().rss, cpu: process.cpuUsage(), eventLoopP95Ms: eventLoop.percentile(95) / 1e6, uptime: process.uptime() }));
  app.get('/api/session', async (request, reply) => {
    const player = await playerFor(request); return player ? { player } : reply.code(401).send({ error: 'Choose a name to join.' });
  });
  app.post('/api/session', async (request, reply) => {
    const parsed = identitySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Use a name of 1–20 letters or numbers and a valid avatar.' });
    const existing = await playerFor(request); if (existing) return { player: existing };
    const { token, player } = await store.createSession(parsed.data.name, parsed.data.avatar);
    reply.setCookie('doodle_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', path: '/', maxAge: 8 * 86400 });
    return { player };
  });
  app.post('/api/rooms', async (request, reply) => {
    const player = await playerFor(request); if (!player) return reply.code(401).send({ error: 'Choose your name first.' });
    if (!leaseHealthy) return reply.code(503).send({ error: 'Server is recovering. Try again shortly.' });
    if (!limits.take(`create:${request.ip}`, Number(process.env.ROOM_CREATE_RATE ?? 5) / 60, Number(process.env.ROOM_CREATE_RATE ?? 5))) return reply.code(429).send({ error: 'Please wait before creating another room.' });
    if (actors.size >= Number(process.env.MAX_ROOMS ?? 200)) return reply.code(503).send({ error: 'Server is full. Please try again later.' });
    const id = randomBytes(8).toString('base64url'); const state = createRoom(id, player, Date.now());
    const actor = makeActor(state);
    await commit(actor, { state: { ...state }, effects: [], reply: { kind: 'ok' } }, player.id, randomUUID());
    actors.set(id, actor); return reply.code(201).send({ roomId: id });
  });
  app.get<{ Params: { roomId: string } }>('/api/rooms/:roomId', async (request, reply) => {
    const actor = actors.get(request.params.roomId);
    return actor ? { roomId: actor.state.id, phase: actor.state.phase, players: actor.state.players.filter(p => !p.departed).length } : reply.code(404).send({ error: 'This room does not exist or has expired.' });
  });
  async function replayMember(roomId: string, player: PlayerIdentity | null) {
    if (!player) return false;
    const state = actors.get(roomId)?.state ?? (await store.load(roomId))?.state;
    return state?.players.some(p => p.id === player.id) && !state.bannedIds.includes(player.id);
  }
  app.get<{ Params: { roomId: string; gameId: string } }>('/api/rooms/:roomId/games/:gameId', async (request, reply) => {
    const { roomId, gameId } = request.params;
    if (!await replayMember(roomId, await playerFor(request))) return reply.code(403).send({ error: 'Only room participants can view replays.' });
    const replay = await store.replay(roomId, gameId); return replay ?? reply.code(404).send({ error: 'Replay becomes available when the game ends.' });
  });
  app.get<{ Params: { roomId: string; gameId: string; turnId: string } }>('/api/rooms/:roomId/games/:gameId/turns/:turnId', async (request, reply) => {
    const { roomId, gameId, turnId } = request.params;
    if (!await replayMember(roomId, await playerFor(request))) return reply.code(403).send({ error: 'Only room participants can view replays.' });
    const drawing = await store.replayDrawing(roomId, gameId, turnId); return drawing ?? reply.code(404).send({ error: 'Drawing unavailable.' });
  });
  io.use(async (socket, next) => {
    try {
      const ip = socket.handshake.address;
      if (!limits.take(`socket:${ip}`, Number(process.env.SOCKET_CONNECTION_RATE ?? 5), Number(process.env.SOCKET_CONNECTION_RATE ?? 5) * 6)) return next(new Error('Too many connections. Please wait.'));
      const player = await store.session(app.parseCookie(socket.request.headers.cookie ?? '').doodle_session);
      const roomId = socket.handshake.auth.roomId;
      if (!player) return next(new Error('Choose your name before joining.'));
      if (typeof roomId !== 'string' || !actors.has(roomId)) return next(new Error('Room not found or expired.'));
      if (closing || !leaseHealthy) return next(new Error('Server is restarting. Please reconnect.'));
      socket.data.player = player; socket.data.roomId = roomId; next();
    } catch { next(new Error('Server is recovering. Please reconnect.')); }
  });
  io.on('connection', socket => {
    const player = socket.data.player as PlayerIdentity;
    const actor = actors.get(socket.data.roomId as string)!;
    socket.on('command', (payload: unknown, respond: unknown) => {
      const ack = typeof respond === 'function' ? respond as (value: Ack) => void : () => undefined;
      const now = Date.now(); metrics.commands++;
      const parsed = commandSchema.safeParse(payload);
      if (!parsed.success) { metrics.rejected++; ack({ ok: false, error: 'Invalid command.', code: 'INVALID' }); return; }
      const envelope = parsed.data; const key = `${player.id}:${envelope.id}`;
      const receipt = actor.receipts.get(key); if (receipt) { ack(receipt); return; }
      const kind = envelope.command.type;
      const allowed = kind === 'draw' ? limits.take(`${player.id}:draw`, 60, 90, 1, now) : kind === 'guess' ? limits.take(`${player.id}:chat`, 2, 5, 1, now) : limits.take(`${player.id}:control`, 3, 10, 1, now);
      if (!allowed) { metrics.rejected++; ack({ ok: false, error: 'Slow down a little. Try again shortly.', code: 'RATE_LIMIT' }); return; }
      void enqueue(actor, async () => {
        if (actor.sockets.get(player.id) !== socket || !socket.connected) return { ok: false, error: 'This session is no longer active.', code: 'SESSION' } as Ack;
        const prior = actor.receipts.get(key); if (prior) return prior;
        if (actor.recovering || !leaseHealthy) return { ok: false, error: 'Reconnecting to storage. Please wait.', code: 'RECOVERING' } as Ack;
        const durableReceipt = await store.journal.findOne({ roomId: actor.state.id, actorId: player.id, commandId: envelope.id }, { projection: { ack: 1 } });
        if (durableReceipt) { actor.receipts.set(key, durableReceipt.ack); return durableReceipt.ack; }
        const command = envelope.command;
        const result = command.type === 'draw' ? await draw(actor, player.id, envelope.id, command.turnId, command.op, now) : await commit(actor, applyCommand(actor.state, player.id, command, now), player.id, envelope.id);
        actor.receipts.set(key, result); if (actor.receipts.size > 10000) actor.receipts.delete(actor.receipts.keys().next().value!);
        if (command.type === 'leave' && result.ok) { actor.sockets.delete(player.id); socket.leave(actor.state.id); }
        return result;
      }).then(ack).catch(() => { unavailable(actor); ack({ ok: false, error: 'Reconnecting safely. Please retry shortly.', code: 'RECOVERING' }); });
    });
    socket.on('sync', () => {
      if (actor.sockets.get(player.id) !== socket || !limits.take(`${player.id}:sync`, 0.5, 3)) return;
      void enqueue(actor, async () => { socket.emit('snapshot', snapshot(actor, player.id)); }).catch(() => undefined);
    });
    socket.on('disconnect', () => {
      void enqueue(actor, async () => {
        if (actor.sockets.get(player.id) !== socket || closing) return;
        actor.sockets.delete(player.id); if (actor.state.turn?.drawerId === player.id) actor.stroke = null;
        await commit(actor, disconnectPlayer(actor.state, player.id, Date.now()));
      }).catch(() => unavailable(actor));
    });
    void enqueue(actor, async () => {
      if (actor.recovering) throw new Error('Room is recovering');
      const result = joinRoom(actor.state, player, Date.now());
      const ack = await commit(actor, result);
      if (!ack.ok) { socket.emit('kicked', { message: ack.error }); socket.disconnect(true); return; }
      const old = actor.sockets.get(player.id); actor.sockets.set(player.id, socket);
      if (old && old !== socket) { old.emit('kicked', { message: 'Your room is open in another tab.' }); old.disconnect(true); }
      await socket.join(actor.state.id); socket.emit('snapshot', snapshot(actor, player.id));
    }).catch(() => { socket.emit('kicked', { message: 'The room is reconnecting. Please try again.' }); socket.disconnect(true); });
  });
  let ticking = false;
  const tick = setInterval(() => {
    if (closing || ticking || !leaseHealthy) return;
    ticking = true;
    void Promise.all([...actors.values()].map(actor => {
      if (actor.pending > 0) return Promise.resolve();
      return enqueue(actor, async () => {
        try {
          if (actor.recovering) { await recover(actor); return; }
          await commit(actor, advance(actor.state, Date.now()));
          if (!actor.sockets.size && Date.now() - actor.state.lastActiveAt > 3600000) actors.delete(actor.state.id);
        } catch { unavailable(actor); }
      });
    })).finally(() => { ticking = false; });
  }, 250);
  let checkingLease = false;
  const leaseTimer = setInterval(() => {
    if (checkingLease || closing) return; checkingLease = true;
    void store.lease().then(healthy => { leaseHealthy = healthy; if (!healthy) for (const actor of actors.values()) unavailable(actor); }).catch(() => { leaseHealthy = false; for (const actor of actors.values()) unavailable(actor); }).finally(() => { checkingLease = false; });
    limits.sweep();
  }, 5000);
  async function close() {
    if (closing) return; closing = true; clearInterval(tick); clearInterval(leaseTimer); eventLoop.disable();
    await Promise.all([...actors.values()].map(actor => actor.queue));
    await new Promise<void>(resolve => io.close(() => resolve()));
    await app.close();
    await store.release(); await store.client.close();
  }
  return { app, io, store, close };
}
