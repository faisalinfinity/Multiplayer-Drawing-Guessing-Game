import { z } from 'zod';

export const WIDTH = 800;
export const HEIGHT = 600;
export const PALETTE = ['#25243a', '#ffffff', '#8d8c9e', '#ef6461', '#ffad64', '#f7d65c', '#62b895', '#64c4d8', '#6384dc', '#9b7bd4', '#e18eaf', '#976647'] as const;
export const settingsSchema = z.object({
  rounds: z.number().int().min(1).max(10),
  drawSeconds: z.number().int().min(15).max(180),
  wordMode: z.enum(['builtin', 'custom', 'mixed']),
}).strict();
export const settingsInputSchema = settingsSchema.extend({ customWords: z.array(z.string().trim().min(2).max(32)).max(500) }).strict();
export type RoomSettings = z.infer<typeof settingsSchema>;
export type SettingsInput = z.infer<typeof settingsInputSchema>;
export const DEFAULT_SETTINGS: RoomSettings = { rounds: 3, drawSeconds: 80, wordMode: 'builtin' };
export const identitySchema = z.object({ name: z.string().trim().min(1).max(20).regex(/^[\p{L}\p{N} _'-]+$/u), avatar: z.number().int().min(0).max(7).default(0) }).strict();
export interface PlayerIdentity { id: string; name: string; avatar: number }
export interface PublicPlayer extends PlayerIdentity { score: number; connected: boolean; guessed: boolean; departed: boolean }
export interface ChatMessage { id: string; playerId?: string; name?: string; text: string; kind: 'chat' | 'system' | 'success'; at: number }
export type Phase = 'lobby' | 'choosing' | 'drawing' | 'reveal' | 'waiting' | 'results';
export interface PublicTurn { id: string; drawerId: string; deadline: number; startedAt: number; mask: string; eligibleIds: string[]; revealedWord?: string; reason?: string }
export interface PublicRoom { id: string; version: number; hostId: string; settings: RoomSettings; phase: Phase; round: number; players: PublicPlayer[]; turn: PublicTurn | null; gameId: string | null; completedGames: string[]; chat: ChatMessage[] }
export interface PrivateState { choices?: string[]; word?: string; customWords?: string[] }
export const pointSchema = z.object({ x: z.number().int().min(0).max(WIDTH - 1), y: z.number().int().min(0).max(HEIGHT - 1) }).strict();
export type Point = z.infer<typeof pointSchema>;
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const id = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const drawingOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stroke'), strokeId: id, index: z.number().int().min(0).max(8192), tool: z.enum(['pen', 'eraser']), color, size: z.number().int().min(1).max(40), points: z.array(pointSchema).min(1).max(64), end: z.boolean() }).strict(),
  z.object({ type: z.literal('fill'), point: pointSchema, color }).strict(),
  z.object({ type: z.literal('undo') }).strict(),
  z.object({ type: z.literal('clear') }).strict(),
]);
export type DrawingOp = z.infer<typeof drawingOpSchema>;
export interface DrawingEvent { seq: number; turnId: string; commandId: string; at: number; op: DrawingOp }
export const engineCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('settings'), settings: settingsInputSchema }).strict(),
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('choose'), turnId: id, index: z.number().int().min(0).max(2) }).strict(),
  z.object({ type: z.literal('guess'), turnId: id.optional(), text: z.string().trim().min(1).max(200) }).strict(),
  z.object({ type: z.literal('kick'), playerId: id }).strict(),
  z.object({ type: z.literal('leave') }).strict(),
  z.object({ type: z.literal('lobby') }).strict(),
]);
export type EngineCommand = z.infer<typeof engineCommandSchema>;
export const commandSchema = z.object({ id, command: z.union([engineCommandSchema, z.object({ type: z.literal('draw'), turnId: id, op: drawingOpSchema }).strict()]) }).strict();
export type CommandEnvelope = z.infer<typeof commandSchema>;
export type Command = CommandEnvelope['command'];
export interface Ack { ok: boolean; error?: string; code?: string; feedback?: 'correct' | 'close' | 'chat' | 'ok'; points?: number; seq?: number }
export interface Snapshot { state: PublicRoom; playerId: string; private: PrivateState; drawing: DrawingEvent[]; serverTime: number }
export interface ReplaySummary { turnId: string; word: string; drawerId: string; drawerName: string; startedAt: number; endedAt: number; reason: string }
export interface ReplayIndex { gameId: string; roomId: string; endedAt: number; players: PublicPlayer[]; drawings: ReplaySummary[] }
export interface ReplayDrawing extends ReplaySummary { events: DrawingEvent[] }
