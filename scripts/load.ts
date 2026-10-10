import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus, freemem, hostname, platform, release, totalmem } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io, type Socket } from 'socket.io-client';
import type { Ack, Command, DrawingEvent, PlayerIdentity, PrivateState, PublicRoom, Snapshot } from '../packages/shared/src/index.js';

/** All players use real HTTP sessions and Socket.IO connections; no server internals. */
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1] ?? '';
};
if (args.includes('--help')) {
  console.log('Usage: BASE_URL=http://localhost:3000 pnpm load --rooms 5 --seconds 600 --output artifacts/load-5.json [--warmup 5] [--one-way-delay-ms 25]');
  console.log('Set ORIGIN separately when the accepted server origin differs from BASE_URL. Enable server metrics with ENABLE_METRICS=true.');
  process.exit(0);
}
const roomCount = Number(option('rooms', '1'));
const seconds = Number(option('seconds', '60'));
const warmupSeconds = Number(option('warmup', '5'));
const oneWayDelayMs = Number(option('one-way-delay-ms', '25'));
const output = resolve(option('output', `artifacts/load-${roomCount}-${seconds}s.json`));
const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const origin = process.env.ORIGIN ?? new URL(baseUrl).origin;
const cpuBudgetCores = Number(process.env.LOAD_CPU_CORES ?? '1');
if (!Number.isInteger(roomCount) || roomCount < 1 || roomCount > 200
  || !Number.isFinite(seconds) || seconds < 1 || seconds > 86_400
  || !Number.isFinite(warmupSeconds) || warmupSeconds < 0 || warmupSeconds > 600
  || !Number.isFinite(oneWayDelayMs) || oneWayDelayMs < 0 || oneWayDelayMs > 1_000
  || !Number.isFinite(cpuBudgetCores) || cpuBudgetCores <= 0) {
  throw new Error('Invalid load options. Rooms:1–200; seconds:1–86400; warmup:0–600; one-way delay:0–1000; LOAD_CPU_CORES must be positive.');
}

const PLAYERS = 8;
const BATCHES_PER_SECOND = 30;
const POINTS_PER_BATCH = 8;
const ACK_TIMEOUT_MS = 5_000;
const RETAIN_COMMAND_MS = 12_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fixed memory, nearest upper 1 ms bucket; retain exact mean/max separately. */
class Histogram {
  readonly buckets = new Uint32Array(60_001);
  count = 0;
  sum = 0;
  max = 0;
  add(ms: number) {
    const value = Math.max(0, ms);
    this.buckets[Math.min(60_000, Math.ceil(value))]++;
    this.count++;
    this.sum += value;
    this.max = Math.max(this.max, value);
  }
  percentile(fraction: number): number | null {
    if (!this.count) return null;
    const target = Math.ceil(this.count * fraction);
    let accumulated = 0;
    for (let index = 0; index < this.buckets.length; index++) {
      accumulated += this.buckets[index]!;
      if (accumulated >= target) return index;
    }
    return 60_000;
  }
  summary() { return { count: this.count, meanMs: this.count ? this.sum / this.count : null, p50Ms: this.percentile(0.5), p95Ms: this.percentile(0.95), p99Ms: this.percentile(0.99), maxMs: this.max, quantizationMs: 1 }; }
}

interface Player {
  identity: PlayerIdentity;
  cookie: string;
  socket: Socket;
  private: PrivateState;
  plannedOffline: boolean;
  nextGuessAt: number;
}
interface Room {
  id: string;
  players: Player[];
  state: PublicRoom | null;
  choosingTurn?: string;
  nextDrawAt: number;
  strokeId: string;
  strokeIndex: number;
  strokeTurn?: string;
  drawingMs: number;
  drawAttempts: number;
  reconnectIndex: number;
}
interface DrawingSample {
  createdAt: number;
  emittedAt: number;
  measured: boolean;
  expected: Set<string>;
  received: Set<string>;
  confirmed: boolean;
}
interface ServerMetrics {
  commands: number;
  rejected: number;
  drawingBatches: number;
  durableMsTotal: number;
  durableMsMax: number;
  commits: number;
  rooms: number;
  connected: number;
  rss: number;
  eventLoopP95Ms: number;
  uptime: number;
  cpu?: { user: number; system: number };
}
interface MetricSample {
  elapsedSeconds: number;
  server: ServerMetrics;
  interval?: { cpuPercentOfOneCore: number; cpuPercentOfBudget: number; meanDurableMs: number | null; commits: number };
}

const rooms: Room[] = [];
const drawingSamples = new Map<string, DrawingSample>();
const pending = new Set<Promise<unknown>>();
const rawDelivery = new Histogram();
const emulatedDelivery = new Histogram();
const rawAck = new Histogram();
const emulatedAck = new Histogram();
const metricSamples: MetricSample[] = [];
const errors: Record<string, number> = {};
const setupErrors: string[] = [];
const totals = { commands: 0, accepted: 0, rejected: 0, timedOut: 0, drawAttempted: 0, drawConfirmed: 0, expectedDeliveries: 0, receivedDeliveries: 0, duplicates: 0, reconnects: 0, unexpectedDisconnects: 0, connectionErrors: 0, metricsErrors: 0, setupRetries: 0 };
let running = false;
let measuring = false;
let stopping = false;
let interrupted = false;
let measurementStarted = 0;
let measurementEnded = 0;
let metricRequestPending = false;
let lastMetric: { at: number; value: ServerMetrics } | undefined;

function countError(code: string) { errors[code] = (errors[code] ?? 0) + 1; }
function track<T>(promise: Promise<T>): Promise<T> {
  pending.add(promise);
  void promise.finally(() => pending.delete(promise)).catch(() => undefined);
  return promise;
}

async function post(path: string, body: unknown, cookie?: string): Promise<{ body: Record<string, unknown>; cookie?: string }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429 && attempt < 4) { totals.setupRetries++; await sleep(1_000 * (attempt + 1)); continue; }
    const value = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`${path} returned ${response.status}: ${String(value.error ?? 'request failed')}`);
    return { body: value, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  throw new Error('HTTP setup retries exhausted.');
}

function confirm(sample: DrawingSample) {
  if (sample.confirmed || !sample.measured) return;
  sample.confirmed = true;
  totals.drawConfirmed++;
  totals.expectedDeliveries += sample.expected.size;
}

/** Both delays are scheduled, rather than merely added to a result after the fact. */
async function send(room: Room, player: Player, command: Command): Promise<Ack> {
  const measured = measuring;
  const createdAt = performance.now();
  const id = randomUUID();
  if (measured) totals.commands++;
  if (measured && command.type === 'draw') { totals.drawAttempted++; room.drawAttempts++; }
  if (oneWayDelayMs) await sleep(oneWayDelayMs);
  const emittedAt = performance.now();
  let sample: DrawingSample | undefined;
  if (command.type === 'draw') {
    sample = {
      createdAt, emittedAt, measured, confirmed: false, received: new Set(),
      expected: new Set(room.players.filter((other) => other !== player && other.socket.connected && !other.plannedOffline).map((other) => other.identity.id)),
    };
    drawingSamples.set(id, sample);
  }
  const response = await new Promise<{ ack: Ack; receivedAt: number }>((resolve) => {
    if (!player.socket.connected) { resolve({ ack: { ok: false, code: 'CLIENT_DISCONNECTED' }, receivedAt: performance.now() }); return; }
    player.socket.timeout(ACK_TIMEOUT_MS).emit('command', { id, command }, (error: Error | null, ack?: Ack) => {
      resolve({ ack: error || !ack ? { ok: false, code: 'ACK_TIMEOUT' } : ack, receivedAt: performance.now() });
    });
  }).catch(() => ({ ack: { ok: false, code: 'CLIENT_EMIT_EXCEPTION' } as Ack, receivedAt: performance.now() }));
  if (sample && response.ack.ok) confirm(sample);
  if (oneWayDelayMs) await sleep(oneWayDelayMs);
  if (measured) {
    rawAck.add(response.receivedAt - emittedAt);
    emulatedAck.add(performance.now() - createdAt);
    if (response.ack.ok) totals.accepted++;
    else {
      totals.rejected++;
      if (response.ack.code === 'ACK_TIMEOUT') totals.timedOut++;
      countError(response.ack.code ?? response.ack.error ?? 'UNKNOWN_REJECTION');
    }
  }
  return response.ack;
}

function maybeChoose(room: Room) {
  if (!running || room.state?.phase !== 'choosing' || !room.state.turn || room.choosingTurn === room.state.turn.id) return;
  const drawer = room.players.find((player) => player.identity.id === room.state!.turn!.drawerId);
  if (!drawer?.socket.connected || !drawer.private.choices?.length) return;
  // Choices are obtained only through the drawer's private server message.
  room.choosingTurn = room.state.turn.id;
  void track(send(room, drawer, { type: 'choose', turnId: room.state.turn.id, index: 0 })).catch(() => countError('CLIENT_CHOOSE_EXCEPTION'));
}

function updateState(room: Room, state: PublicRoom) {
  if (room.state && state.version < room.state.version) return;
  room.state = state;
  maybeChoose(room);
}

async function connectPlayer(room: Room, identity: PlayerIdentity, cookie: string): Promise<Player> {
  const socket = io(baseUrl, {
    autoConnect: false, forceNew: true, transports: ['websocket'], reconnection: true,
    reconnectionDelay: 1_000, reconnectionDelayMax: 2_000, timeout: 10_000,
    auth: { roomId: room.id }, extraHeaders: { Cookie: cookie, Origin: origin },
  });
  const player: Player = { identity, cookie, socket, private: {}, plannedOffline: false, nextGuessAt: 0 };
  room.players.push(player);
  socket.on('snapshot', (snapshot: Snapshot) => {
    player.private = snapshot.private;
    updateState(room, snapshot.state);
    // Planned reconnect intervals end only after the authoritative snapshot arrives.
    player.plannedOffline = false;
  });
  socket.on('state', (payload: { state: PublicRoom }) => updateState(room, payload.state));
  socket.on('private', (value: PrivateState) => { player.private = value; maybeChoose(room); });
  socket.on('drawing', (event: DrawingEvent) => {
    const sample = drawingSamples.get(event.commandId);
    if (!sample?.measured || !sample.expected.has(identity.id)) return;
    if (sample.received.has(identity.id)) { totals.duplicates++; return; }
    sample.received.add(identity.id);
    confirm(sample);
    const receivedAt = performance.now();
    const finish = () => {
      totals.receivedDeliveries++;
      rawDelivery.add(receivedAt - sample.emittedAt);
      emulatedDelivery.add(performance.now() - sample.createdAt);
    };
    if (oneWayDelayMs) setTimeout(finish, oneWayDelayMs); else finish();
  });
  socket.on('connect_error', (error: Error) => {
    if (!measuring || stopping || player.plannedOffline) return;
    totals.connectionErrors++; countError(`CONNECT:${error.message}`);
  });
  socket.on('disconnect', () => {
    if (measuring && !stopping && !player.plannedOffline) { totals.unexpectedDisconnects++; countError('UNEXPECTED_DISCONNECT'); }
  });
  socket.on('kicked', () => { if (measuring && !stopping) countError('KICKED'); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('Initial room snapshot timed out.')); }, 20_000);
    socket.once('snapshot', () => { clearTimeout(timer); resolve(); });
    socket.connect();
  });
  return player;
}

async function setupRoom(index: number) {
  let room: Room | undefined;
  try {
    const hostSession = await post('/api/session', { name: `Load ${index + 1} A`, avatar: 0 });
    if (!hostSession.cookie) throw new Error('Session endpoint did not return its cookie.');
    const created = await post('/api/rooms', {}, hostSession.cookie);
    room = { id: String(created.body.roomId), players: [], state: null, nextDrawAt: 0, strokeId: '', strokeIndex: 0, drawingMs: 0, drawAttempts: 0, reconnectIndex: 0 };
    await connectPlayer(room, hostSession.body.player as PlayerIdentity, hostSession.cookie);
    const currentRoom = room;
    for (let indexPlayer = 1; indexPlayer < PLAYERS; indexPlayer++) {
      const session = await post('/api/session', { name: `Load ${index + 1} ${indexPlayer + 1}`, avatar: indexPlayer });
      if (!session.cookie) throw new Error('Session endpoint did not return its cookie.');
      await connectPlayer(currentRoom, session.body.player as PlayerIdentity, session.cookie);
    }
    const ack = await send(room, room.players[0]!, { type: 'settings', settings: { rounds: 10, drawSeconds: 180, wordMode: 'custom', customWords: ['volcano', 'elephant', 'rainbow'] } });
    if (!ack.ok) throw new Error(`Settings rejected: ${ack.code ?? ack.error}`);
    rooms.push(room);
    console.log(`Prepared room ${index + 1}/${roomCount}: ${room.id}, ${room.players.length} independent sessions.`);
  } catch (error) {
    setupErrors.push(`Room ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    for (const player of room?.players ?? []) player.socket.disconnect();
    console.error(setupErrors.at(-1));
  }
}

function drawingCommand(room: Room, drawer: Player) {
  const turnId = room.state!.turn!.id;
  if (room.strokeTurn !== turnId || room.strokeIndex >= BATCHES_PER_SECOND) {
    room.strokeTurn = turnId; room.strokeId = randomUUID(); room.strokeIndex = 0;
  }
  const index = room.strokeIndex++;
  const seed = room.drawAttempts % 700;
  const points = Array.from({ length: POINTS_PER_BATCH }, (_, i) => ({ x: 40 + ((seed + i * 3) % 700), y: 40 + ((index * 8 + i * 2) % 500) }));
  void track(send(room, drawer, {
    type: 'draw', turnId, op: { type: 'stroke', strokeId: room.strokeId, index, tool: 'pen', color: '#6384dc', size: 4, points, end: index === BATCHES_PER_SECOND - 1 },
  })).catch(() => countError('CLIENT_DRAW_EXCEPTION'));
}

function workloadTick(at: number, elapsedMs: number) {
  for (const room of rooms) {
    const state = room.state;
    if (!state?.turn || state.phase !== 'drawing') { room.nextDrawAt = at; continue; }
    const drawer = room.players.find((player) => player.identity.id === state.turn!.drawerId);
    if (!drawer?.socket.connected || drawer.plannedOffline) continue;
    if (measuring) room.drawingMs += elapsedMs;
    if (at >= room.nextDrawAt) {
      room.nextDrawAt = Math.max(room.nextDrawAt + 1_000 / BATCHES_PER_SECOND, at);
      drawingCommand(room, drawer);
    }
    for (const player of room.players) {
      if (player === drawer || player.plannedOffline || !player.socket.connected || at < player.nextGuessAt) continue;
      player.nextGuessAt = at + 5_000;
      void track(send(room, player, { type: 'guess', turnId: state.turn.id, text: 'load test wrong guess' })).catch(() => countError('CLIENT_GUESS_EXCEPTION'));
    }
  }
}

async function reconnectOne(room: Room) {
  const eligible = room.players.filter((player) => player.identity.id !== room.state?.turn?.drawerId && player.socket.connected);
  if (!eligible.length) return;
  const player = eligible[room.reconnectIndex++ % eligible.length]!;
  player.plannedOffline = true;
  player.socket.disconnect();
  totals.reconnects++;
  await sleep(1_000);
  if (!running) return;
  player.socket.connect();
}

async function sampleMetrics() {
  if (metricRequestPending) return;
  metricRequestPending = true;
  try {
    const response = await fetch(`${baseUrl}/api/metrics`, { headers: { Origin: origin }, signal: AbortSignal.timeout(4_000) });
    if (!response.ok) throw new Error(`Metrics HTTP ${response.status}`);
    const server = await response.json() as ServerMetrics;
    const at = performance.now();
    const sample: MetricSample = { elapsedSeconds: (at - measurementStarted) / 1_000, server };
    if (lastMetric?.value.cpu && server.cpu && at > lastMetric.at) {
      const cpuMicros = server.cpu.user + server.cpu.system - lastMetric.value.cpu.user - lastMetric.value.cpu.system;
      const cpuPercentOfOneCore = cpuMicros / ((at - lastMetric.at) * 1_000) * 100;
      const commits = server.commits - lastMetric.value.commits;
      sample.interval = { cpuPercentOfOneCore, cpuPercentOfBudget: cpuPercentOfOneCore / cpuBudgetCores, commits, meanDurableMs: commits > 0 ? (server.durableMsTotal - lastMetric.value.durableMsTotal) / commits : null };
    }
    metricSamples.push(sample);
    lastMetric = { at, value: server };
  } catch { totals.metricsErrors++; }
  finally { metricRequestPending = false; }
}

function stats(values: number[]) {
  if (!values.length) return { count: 0, mean: null, min: null, p95: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, mean: values.reduce((a, b) => a + b, 0) / values.length, min: sorted[0]!, p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!, max: sorted.at(-1)! };
}

async function finish() {
  stopping = true; running = false; measuring = false;
  await Promise.allSettled([...pending]);
  // Event-receive delay callbacks can outlive their command acknowledgements briefly.
  await sleep(Math.max(100, oneWayDelayMs * 2));
  await sampleMetrics();
  for (const room of rooms) for (const player of room.players) player.socket.disconnect();
  const durationSeconds = (measurementEnded - measurementStarted) / 1_000;
  const errorRate = totals.commands ? totals.rejected / totals.commands : 1;
  const deliveryRatio = totals.expectedDeliveries ? totals.receivedDeliveries / totals.expectedDeliveries : 0;
  const expectedDrawBatches = rooms.reduce((sum, room) => sum + room.drawingMs / 1_000 * BATCHES_PER_SECOND, 0);
  const achievedWorkload = expectedDrawBatches ? totals.drawAttempted / expectedDrawBatches : 0;
  const roomWorkloads = rooms.map((room) => ({ roomId: room.id, drawAttempts: room.drawAttempts, drawingSeconds: room.drawingMs / 1_000, fractionOfMeasurementDrawing: room.drawingMs / Math.max(1, durationSeconds * 1_000) }));
  const cpu = stats(metricSamples.flatMap((sample) => sample.interval ? [sample.interval.cpuPercentOfBudget] : []));
  const rss = stats(metricSamples.map((sample) => sample.server.rss));
  const middleRss = stats(metricSamples.filter((sample) => sample.elapsedSeconds >= durationSeconds / 3 && sample.elapsedSeconds < durationSeconds * 2 / 3).map((sample) => sample.server.rss));
  const lastRss = stats(metricSamples.filter((sample) => sample.elapsedSeconds >= durationSeconds * 2 / 3 && sample.elapsedSeconds <= durationSeconds).map((sample) => sample.server.rss));
  const memoryGrowth = middleRss.mean !== null && lastRss.mean !== null ? lastRss.mean - middleRss.mean : null;
  const memoryAllowance = middleRss.mean !== null ? Math.max(64 * 1024 * 1024, middleRss.mean * 0.25) : null;
  const criteria = {
    completeSetup: rooms.length === roomCount && setupErrors.length === 0,
    tenMinuteSustain: durationSeconds >= 599 && !interrupted,
    p95EmulatedDeliveryBelow150ms: (emulatedDelivery.percentile(0.95) ?? Infinity) < 150,
    commandErrorsBelowOnePercent: errorRate < 0.01,
    deliveryAtLeast999PerThousand: deliveryRatio >= 0.999,
    requestedWorkloadAtLeast95Percent: achievedWorkload >= 0.95,
    eachRoomDrawingAtLeast90PercentOfRun: roomWorkloads.length > 0 && roomWorkloads.every((room) => room.fractionOfMeasurementDrawing >= 0.9),
    cpuP95Below80PercentOfBudget: cpu.p95 !== null && cpu.p95 < 80,
    memoryStable: memoryGrowth !== null && memoryAllowance !== null && memoryGrowth <= memoryAllowance,
    noUnexpectedDisconnects: totals.unexpectedDisconnects === 0,
    metricsAvailable: metricSamples.length >= 3 && totals.metricsErrors === 0,
  };
  const report = {
    schemaVersion: 1, recordedAt: new Date().toISOString(), baseUrl, origin,
    requested: { rooms: roomCount, playersPerRoom: PLAYERS, seconds, warmupSeconds, batchesPerSecond: BATCHES_PER_SECOND, pointsPerBatch: POINTS_PER_BATCH },
    actual: { rooms: rooms.length, players: rooms.reduce((n, room) => n + room.players.length, 0), durationSeconds, interrupted, expectedDrawBatches, achievedWorkload, averageDrawBatchesPerSecond: totals.drawAttempted / Math.max(1, durationSeconds), roomWorkloads },
    transport: { protocol: 'Socket.IO over websocket', measurement: 'Command creation to observer event callback; excludes browser canvas rendering', network: 'application-emulated delay, not physical network shaping', oneWayDelayMs, nominalRoundTripDelayMs: oneWayDelayMs * 2, baseMeasurement: 'Server/network receive timestamp minus actual socket emit timestamp', emulatedMeasurement: 'Delayed observer callback timestamp minus command creation timestamp', clock: 'shared monotonic performance.now across independent client sessions in one process' },
    latency: { observerBase: rawDelivery.summary(), observerWithEmulatedNetwork: emulatedDelivery.summary(), acknowledgementBase: rawAck.summary(), acknowledgementWithEmulatedNetwork: emulatedAck.summary() },
    totals, errorCodes: errors, commandErrorRate: errorRate, deliveryRatio,
    server: { cpuBudgetCores, cpuPercentOfBudget: cpu, rssBytes: rss, memoryStability: { middleThirdMeanBytes: middleRss.mean, lastThirdMeanBytes: lastRss.mean, growthBytes: memoryGrowth, allowedGrowthBytes: memoryAllowance }, eventLoopP95Ms: stats(metricSamples.map((sample) => sample.server.eventLoopP95Ms)), intervalMeanDurableMs: stats(metricSamples.flatMap((sample) => sample.interval?.meanDurableMs !== null && sample.interval?.meanDurableMs !== undefined ? [sample.interval.meanDurableMs] : [])), samples: metricSamples },
    clientMachine: { hostname: hostname(), platform: platform(), release: release(), node: process.version, logicalCpus: cpus().length, cpuModel: cpus()[0]?.model, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), clientRssBytes: process.memoryUsage().rss },
    setupErrors, criteria, passed: Object.values(criteria).every(Boolean),
    recommendedRoomsWith30PercentHeadroom: Object.values(criteria).every(Boolean) ? Math.floor(rooms.length * 0.7) : null,
    limitations: ['Node clients do not measure browser rendering or mobile CPU.', 'Application delays emulate latency only, not network jitter, bandwidth limits, loss or congestion.', 'Same-host client/server/database runs compete for CPU and memory; report the actual deployment topology separately.', 'CPU budget defaults to one logical core; LOAD_CPU_CORES must match an enforced or explicitly documented server allocation.', 'A passing short run is a screening result; only at least ten minutes qualifies a capacity estimate.', 'Retained rooms from previous runs contaminate memory/room counts: restart the isolated benchmark server/database between runs.'],
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, rooms: rooms.length, seconds: durationSeconds, p95Ms: emulatedDelivery.percentile(0.95), errorRate, deliveryRatio, achievedWorkload, cpuP95Percent: cpu.p95, passed: report.passed, criteria }, null, 2));
  if (!criteria.completeSetup || !totals.drawConfirmed) process.exitCode = 1;
}

process.on('SIGINT', () => { interrupted = true; running = false; });
process.on('SIGTERM', () => { interrupted = true; running = false; });

console.log(`Preparing ${roomCount} rooms × ${PLAYERS} players against ${baseUrl}; accepted origin ${origin}.`);
// Four independent setup workers keep creation bounded without masking gameplay pressure.
let nextSetup = 0;
await Promise.all(Array.from({ length: Math.min(4, roomCount) }, async () => {
  while (nextSetup < roomCount && !interrupted) await setupRoom(nextSetup++);
}));
rooms.sort((a, b) => a.id.localeCompare(b.id));
if (!rooms.length || interrupted) {
  measurementStarted = measurementEnded = performance.now();
  await finish();
} else {
  running = true;
  let lastTick = performance.now();
  for (const room of rooms) for (let i = 0; i < room.players.length; i++) room.players[i]!.nextGuessAt = lastTick + i * 500;
  const ticker = setInterval(() => {
    const at = performance.now();
    if (running) workloadTick(at, at - lastTick);
    lastTick = at;
  }, 10);
  await Promise.all(rooms.map(async (room) => {
    const ack = await track(send(room, room.players[0]!, { type: 'start' }));
    if (!ack.ok) setupErrors.push(`Room ${room.id} could not start: ${ack.code ?? ack.error}`);
  }));
  console.log(`Warming up for ${warmupSeconds}s.`);
  if (warmupSeconds) await sleep(warmupSeconds * 1_000);
  measuring = !interrupted;
  measurementStarted = performance.now();
  await sampleMetrics();
  console.log(`Measuring ${seconds}s with ${oneWayDelayMs}ms scheduled delay in each direction.`);
  let nextMetrics = measurementStarted + 5_000;
  let nextReconnect = measurementStarted + 45_000;
  let nextLog = measurementStarted + 15_000;
  while (running && performance.now() - measurementStarted < seconds * 1_000) {
    await sleep(100);
    const at = performance.now();
    if (at >= nextMetrics) { nextMetrics = at + 5_000; void track(sampleMetrics()); }
    if (at >= nextReconnect) { nextReconnect = at + 45_000; for (const room of rooms) void track(reconnectOne(room)); }
    if (at >= nextLog) {
      nextLog = at + 15_000;
      console.log(`${Math.round((at - measurementStarted) / 1_000)}s: ${totals.drawConfirmed} drawings, p95 ${emulatedDelivery.percentile(0.95)}ms, ${totals.rejected} command errors.`);
    }
    for (const [id, sample] of drawingSamples) if (at - sample.createdAt > RETAIN_COMMAND_MS) drawingSamples.delete(id);
  }
  measurementEnded = performance.now();
  clearInterval(ticker);
  await finish();
}
