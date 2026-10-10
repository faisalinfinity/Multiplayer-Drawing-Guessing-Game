import { MongoClient, type Collection } from 'mongodb';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { Ack, DrawingEvent, PlayerIdentity, ReplayIndex, ReplayDrawing, ReplaySummary } from '@doodle/shared';
import type { EngineState, EngineEffect } from './engine.js';

export interface JournalEntry {
  roomId: string; seq: number; actorId: string; commandId: string; kind: 'state' | 'draw';
  gameId: string | null; turnId: string | null; at: number; expiresAt: Date;
  state?: EngineState; effects?: EngineEffect[]; drawing?: DrawingEvent; ack: Ack;
}
interface Session { tokenHash: string; player: PlayerIdentity; expiresAt: Date }
interface Checkpoint { roomId: string; seq: number; state: EngineState; expiresAt: Date }
export class GameStore {
  readonly client: MongoClient;
  readonly journal: Collection<JournalEntry>;
  readonly sessions: Collection<Session>;
  readonly checkpoints: Collection<Checkpoint>;
  private readonly owner = randomUUID();
  private usableUntil = 0;
  private acquiredLease = false;
  private lostLease = false;
  constructor(uri: string) {
    this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 3000, connectTimeoutMS: 3000, socketTimeoutMS: 5000, writeConcern: { w: 'majority', j: true, wtimeoutMS: 3000 } });
    const db = this.client.db();
    this.journal = db.collection('journal'); this.sessions = db.collection('sessions'); this.checkpoints = db.collection('checkpoints');
  }
  async connect() {
    await this.client.connect();
    await Promise.all([
      this.journal.createIndex({ roomId: 1, seq: 1 }, { unique: true }),
      this.journal.createIndex({ roomId: 1, actorId: 1, commandId: 1 }, { unique: true }),
      this.journal.createIndex({ roomId: 1, kind: 1, seq: -1 }),
      this.journal.createIndex({ roomId: 1, gameId: 1, turnId: 1, kind: 1, seq: 1 }),
      this.journal.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.checkpoints.createIndex({ roomId: 1 }, { unique: true }),
      this.checkpoints.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    ]);
  }
  /** A local fail-closed guard, not transactional fencing or support for HA writers. */
  hasLease(): boolean {
    if (this.lostLease || !this.acquiredLease) return false;
    if (performance.now() >= this.usableUntil) { this.lostLease = true; return false; }
    return true;
  }
  assertLease() {
    if (!this.hasLease()) throw new Error('Authoritative lease expired or was lost. Restart this instance.');
  }
  async lease(): Promise<boolean> {
    if (this.lostLease || (this.acquiredLease && !this.hasLease())) return false;
    // Start the clock before database I/O and reserve five seconds for in-flight writes.
    // No old runtime may reacquire after expiry, even if wall-clock time moves backward.
    const started = performance.now();
    const previousDeadline = this.usableUntil;
    const leases = this.client.db().collection<{ name: string; owner: string; until: Date }>('leases');
    await leases.createIndex({ name: 1 }, { unique: true });
    try {
      await leases.updateOne({ name: 'game-server', $or: [{ owner: this.owner }, { until: { $lt: new Date() } }] }, { $set: { owner: this.owner, until: new Date(Date.now() + 15000) } }, { upsert: true });
      if (this.lostLease || (this.acquiredLease && performance.now() >= previousDeadline) || performance.now() >= started + 10000) {
        this.lostLease = true;
        return false;
      }
      this.acquiredLease = true;
      this.usableUntil = started + 10000;
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 11000) { this.lostLease = true; return false; }
      if (this.acquiredLease && performance.now() >= previousDeadline) this.lostLease = true;
      throw error;
    }
  }
  async release() { await this.client.db().collection('leases').deleteOne({ name: 'game-server', owner: this.owner }); }
  async createSession(name: string, avatar: number) {
    this.assertLease();
    const token = randomBytes(32).toString('base64url');
    const player = { id: randomUUID(), name, avatar };
    await this.sessions.insertOne({ tokenHash: this.hash(token), player, expiresAt: new Date(Date.now() + 8 * 86400000) });
    return { token, player };
  }
  async session(token?: string) { if (!token || token.length > 100) return null; return (await this.sessions.findOne({ tokenHash: this.hash(token), expiresAt: { $gt: new Date() } }))?.player ?? null; }
  private hash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  async append(entry: JournalEntry): Promise<{ inserted: boolean; entry: JournalEntry }> {
    this.assertLease();
    try { await this.journal.insertOne(entry); this.assertLease(); return { inserted: true, entry }; }
    catch (error) {
      this.assertLease();
      // An acknowledgement timeout can still mean the write committed. Always resolve by identity.
      const prior = await this.journal.findOne({ roomId: entry.roomId, actorId: entry.actorId, commandId: entry.commandId });
      if (prior) return { inserted: false, entry: prior };
      throw error;
    }
  }
  async checkpoint(state: EngineState, seq: number) {
    this.assertLease();
    await this.checkpoints.updateOne({ roomId: state.id }, { $set: { state, seq, expiresAt: new Date(Date.now() + 8 * 86400000) } }, { upsert: true });
  }
  async load(roomId: string) {
    const checkpoint = await this.checkpoints.findOne({ roomId });
    const newer = await this.journal.findOne({ roomId, kind: 'state', ...(checkpoint ? { seq: { $gt: checkpoint.seq } } : {}) }, { sort: { seq: -1 } });
    const state = newer?.state ?? checkpoint?.state;
    if (!state) return null;
    const last = await this.journal.findOne({ roomId }, { sort: { seq: -1 }, projection: { seq: 1 } });
    const drawing = state.turn ? (await this.journal.find({ roomId, turnId: state.turn.id, kind: 'draw' }).sort({ seq: 1 }).toArray()).flatMap(e => e.drawing ? [e.drawing] : []) : [];
    return { state, seq: last?.seq ?? checkpoint?.seq ?? 0, drawing };
  }
  async roomIds() { return this.journal.distinct('roomId', { at: { $gt: Date.now() - 3600000 } }); }
  async replay(roomId: string, gameId: string): Promise<ReplayIndex | null> {
    const entries = await this.journal.find({ roomId, gameId, kind: 'state', 'effects.0': { $exists: true }, expiresAt: { $gt: new Date() } }, { projection: { effects: 1 } }).sort({ seq: 1 }).toArray();
    const effects = entries.flatMap(e => e.effects ?? []);
    const finish = effects.find(e => e.type === 'game-ended');
    if (!finish || finish.type !== 'game-ended' || finish.endedAt + 7 * 86400000 <= Date.now()) return null;
    const drawings: ReplaySummary[] = effects.filter(e => e.type === 'turn-ended').map(e => {
      if (e.type !== 'turn-ended') throw new Error('Invalid replay event');
      return { turnId: e.turnId, word: e.word, drawerId: e.drawerId, drawerName: e.drawerName, startedAt: e.startedAt, endedAt: e.endedAt, reason: e.reason };
    });
    return { roomId, gameId, endedAt: finish.endedAt, players: finish.players, drawings };
  }
  async replayDrawing(roomId: string, gameId: string, turnId: string, completedGame?: ReplayIndex): Promise<ReplayDrawing | null> {
    const index = completedGame ?? await this.replay(roomId, gameId);
    const summary = index?.drawings.find(d => d.turnId === turnId);
    if (!summary) return null;
    const events = (await this.journal.find({ roomId, gameId, turnId, kind: 'draw' }).sort({ seq: 1 }).toArray()).flatMap(e => e.drawing ? [e.drawing] : []);
    return { ...summary, events };
  }
}
