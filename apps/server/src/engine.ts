import { randomInt } from 'node:crypto';
import {
  DEFAULT_SETTINGS, engineCommandSchema, identitySchema, settingsInputSchema,
  type ChatMessage, type EngineCommand, type Phase, type PlayerIdentity,
  type PrivateState, type PublicPlayer, type PublicRoom, type RoomSettings,
} from '@doodle/shared';
import { BUILTIN_WORDS } from './words.js';

export const CHOICE_MS = 10_000;
export const REVEAL_MS = 4_000;
export const RECONNECT_GRACE_MS = 30_000;
const MAX_CHAT = 100;
const MAX_ROOM_MEMBERS = 128;
export type Random = () => number;
const secureRandom: Random = () => randomInt(0, 0x1_0000_0000) / 0x1_0000_0000;

export interface EnginePlayer extends PublicPlayer {
  joinedAt: number;
  /** A late joiner guesses next turn, but enters the drawing rotation next round. */
  joinedRound: number;
  disconnectedAt?: number;
}

export interface EngineTurn {
  id: string;
  drawerId: string;
  deadline: number;
  startedAt: number;
  eligibleIds: string[];
  choices: string[];
  word?: string;
  hintOrder: number[];
  hintLevel: number;
  reason?: string;
}

/** Private persisted state. It deliberately contains no canvas or stroke history. */
export interface EngineState {
  id: string;
  version: number;
  hostId: string;
  settings: RoomSettings;
  customWords: string[];
  phase: Phase;
  round: number;
  players: EnginePlayer[];
  turn: EngineTurn | null;
  gameId: string | null;
  completedGames: string[];
  chat: ChatMessage[];
  createdAt: number;
  lastActiveAt: number;
  roundOrder: string[];
  turnIndex: number;
  gameCounter: number;
  turnCounter: number;
  messageCounter: number;
  bannedIds: string[];
}

export type EngineEffect =
  | { type: 'turn-opened'; turnId: string; gameId: string; drawerId: string }
  | { type: 'drawing-started'; turnId: string; gameId: string; startedAt: number }
  | { type: 'turn-ended'; turnId: string; gameId: string; word: string; drawerId: string; drawerName: string; startedAt: number; endedAt: number; reason: string }
  | { type: 'game-ended'; gameId: string; endedAt: number; players: PublicPlayer[] };

export interface EngineResult {
  state: EngineState;
  effects: EngineEffect[];
  reply?: { kind: 'ok' | 'correct' | 'close' | 'chat'; points?: number };
  error?: { code: string; message: string };
}

export function normalizeWord(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** Exactly one Unicode-code-point insertion, deletion or substitution. */
export function isNearMiss(guess: string, answer: string): boolean {
  const left = [...normalizeWord(guess)];
  const right = [...normalizeWord(answer)];
  if (right.length < 4 || Math.abs(left.length - right.length) > 1) return false;
  let a = 0;
  let b = 0;
  let edits = 0;
  while (a < left.length && b < right.length) {
    if (left[a] === right[b]) { a++; b++; continue; }
    if (++edits > 1) return false;
    if (left.length <= right.length) b++;
    if (left.length >= right.length) a++;
  }
  return edits + (left.length - a) + (right.length - b) === 1;
}

function shuffled<T>(values: readonly T[], random: Random): T[] {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.max(0, Math.min(i, Math.floor(random() * (i + 1))));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function wordPool(state: EngineState): string[] {
  const words = state.settings.wordMode === 'builtin' ? BUILTIN_WORDS
    : state.settings.wordMode === 'custom' ? state.customWords
      : [...BUILTIN_WORDS, ...state.customWords];
  return [...new Set(words.map(normalizeWord))];
}

function publicPlayer(player: EnginePlayer): PublicPlayer {
  const { id, name, avatar, score, connected, guessed, departed } = player;
  return { id, name, avatar, score, connected, guessed, departed };
}

function mask(turn: EngineTurn): string {
  if (!turn.word) return '';
  const count = Math.min(
    Math.max(0, turn.hintOrder.length - 1),
    turn.hintLevel === 0 ? 0 : Math.max(1, Math.floor(turn.hintOrder.length * turn.hintLevel / 3)),
  );
  const visible = new Set(turn.hintOrder.slice(0, count));
  return [...turn.word].map((letter, i) => !/[\p{L}\p{N}]/u.test(letter) || visible.has(i) ? letter : '_').join('');
}

/** This explicit allowlist is the only public projection of private engine state. */
export function publicState(state: EngineState): PublicRoom {
  return {
    id: state.id, version: state.version, hostId: state.hostId,
    settings: { ...state.settings }, phase: state.phase, round: state.round,
    players: state.players.map(publicPlayer), gameId: state.gameId,
    completedGames: [...state.completedGames], chat: state.chat.map((message) => ({ ...message })),
    turn: state.turn ? {
      id: state.turn.id, drawerId: state.turn.drawerId, deadline: state.turn.deadline,
      startedAt: state.turn.startedAt, eligibleIds: [...state.turn.eligibleIds],
      mask: mask(state.turn),
      ...(state.phase === 'reveal' && state.turn.word ? { revealedWord: state.turn.word, reason: state.turn.reason } : {}),
    } : null,
  };
}

export function privateState(state: EngineState, playerId: string): PrivateState {
  const player = state.players.find((item) => item.id === playerId && !item.departed);
  if (!player) return {};
  return {
    ...(state.phase === 'lobby' && playerId === state.hostId ? { customWords: [...state.customWords] } : {}),
    ...(state.turn?.drawerId === playerId && state.phase === 'choosing' ? { choices: [...state.turn.choices] } : {}),
    ...(state.turn?.drawerId === playerId && state.phase === 'drawing' && state.turn.word ? { word: state.turn.word } : {}),
  };
}

function say(state: EngineState, text: string, at: number, kind: ChatMessage['kind'] = 'system', player?: EnginePlayer): void {
  state.chat.push({
    id: `${state.id}-m${++state.messageCounter}`, text, kind, at,
    ...(player ? { playerId: player.id, name: player.name } : {}),
  });
  if (state.chat.length > MAX_CHAT) state.chat.splice(0, state.chat.length - MAX_CHAT);
}

function member(identity: PlayerIdentity, now: number, joinedRound: number): EnginePlayer {
  return { ...identity, connected: true, departed: false, guessed: false, score: 0, joinedAt: now, joinedRound };
}

export function createRoom(id: string, identity: PlayerIdentity, now: number): EngineState {
  const validated = identitySchema.parse({ name: identity.name, avatar: identity.avatar });
  const state: EngineState = {
    id, version: 0, hostId: identity.id, settings: { ...DEFAULT_SETTINGS }, customWords: [],
    phase: 'lobby', round: 0, players: [member({ ...identity, ...validated }, now, 1)], turn: null,
    gameId: null, completedGames: [], chat: [], createdAt: now, lastActiveAt: now,
    roundOrder: [], turnIndex: 0, gameCounter: 0, turnCounter: 0, messageCounter: 0, bannedIds: [],
  };
  say(state, `${validated.name} created the room.`, now);
  return state;
}

function fail(result: EngineResult, code: string, message: string): EngineResult {
  return { ...result, error: { code, message } };
}

function changed(state: EngineState, effects: EngineEffect[], now: number, reply: EngineResult['reply'] = { kind: 'ok' }): EngineResult {
  state.lastActiveAt = now;
  return { state, effects, reply };
}

function transferHost(state: EngineState, now: number): boolean {
  const host = state.players.find((player) => player.id === state.hostId && !player.departed);
  if (host) return false;
  const next = state.players.find((player) => player.connected && !player.departed);
  if (!next || next.id === state.hostId) return false;
  state.hostId = next.id;
  say(state, `${next.name} is now the host.`, now);
  return true;
}

function gameEnded(state: EngineState, now: number, effects: EngineEffect[]): void {
  state.phase = 'results';
  state.turn = null;
  if (state.gameId) {
    if (!state.completedGames.includes(state.gameId)) state.completedGames.push(state.gameId);
    state.completedGames = state.completedGames.slice(-20);
    effects.push({ type: 'game-ended', gameId: state.gameId, endedAt: now, players: state.players.map(publicPlayer) });
  }
  say(state, 'The game is complete! Explore the drawings in replay.', now);
}

function nextTurn(state: EngineState, now: number, effects: EngineEffect[], random: Random): void {
  if (state.turnIndex >= state.roundOrder.length && state.round >= state.settings.rounds) {
    gameEnded(state, now, effects);
    return;
  }
  if (state.players.filter((player) => player.connected && !player.departed).length < 2) {
    state.phase = 'waiting';
    state.turn = null;
    return;
  }
  for (;;) {
    if (state.turnIndex >= state.roundOrder.length) {
      if (state.round >= state.settings.rounds) { gameEnded(state, now, effects); return; }
      state.round++;
      state.roundOrder = state.players.filter((player) => !player.departed && player.joinedRound <= state.round).map((player) => player.id);
      state.turnIndex = 0;
    }
    const drawerId = state.roundOrder[state.turnIndex++];
    const drawer = state.players.find((player) => player.id === drawerId && player.connected && !player.departed);
    if (!drawer) continue;
    for (const player of state.players) player.guessed = false;
    state.phase = 'choosing';
    state.turn = {
      id: `${state.id}-g${state.gameCounter}-t${++state.turnCounter}`,
      drawerId: drawer.id, startedAt: now, deadline: now + CHOICE_MS,
      eligibleIds: state.players.filter((player) => player.id !== drawer.id && player.connected && !player.departed).map((player) => player.id),
      choices: shuffled(wordPool(state), random).slice(0, 3), hintOrder: [], hintLevel: 0,
    };
    effects.push({ type: 'turn-opened', turnId: state.turn.id, gameId: state.gameId!, drawerId: drawer.id });
    say(state, `${drawer.name} is choosing a word.`, now);
    return;
  }
}

function startDrawing(state: EngineState, index: number, now: number, effects: EngineEffect[], random: Random): void {
  const turn = state.turn!;
  turn.word = turn.choices[index]!;
  turn.startedAt = now;
  turn.deadline = now + state.settings.drawSeconds * 1_000;
  turn.hintOrder = shuffled([...turn.word].flatMap((character, i) => /[\p{L}\p{N}]/u.test(character) ? [i] : []), random);
  turn.hintLevel = 0;
  state.phase = 'drawing';
  effects.push({ type: 'drawing-started', gameId: state.gameId!, turnId: turn.id, startedAt: now });
}

function endTurn(state: EngineState, now: number, reason: string, effects: EngineEffect[], endedAt = now): void {
  const turn = state.turn;
  if (!turn || (state.phase !== 'drawing' && state.phase !== 'choosing')) return;
  turn.word ??= turn.choices[0]!;
  turn.reason = reason;
  state.phase = 'reveal';
  turn.deadline = now + REVEAL_MS;
  effects.push({
    type: 'turn-ended', gameId: state.gameId!, turnId: turn.id, word: turn.word,
    drawerId: turn.drawerId, drawerName: state.players.find((player) => player.id === turn.drawerId)?.name ?? 'Departed player',
    startedAt: turn.startedAt, endedAt, reason,
  });
  say(state, `The word was “${turn.word}”.`, now);
}

function everyoneGuessed(state: EngineState): boolean {
  return Boolean(state.turn) && state.turn!.eligibleIds.every((id) => {
    const player = state.players.find((item) => item.id === id);
    return !player || player.departed || player.guessed;
  });
}

function depart(state: EngineState, player: EnginePlayer, now: number, effects: EngineEffect[]): void {
  player.departed = true;
  player.connected = false;
  delete player.disconnectedAt;
  say(state, `${player.name} left the room.`, now);
  transferHost(state, now);
  if (state.turn?.drawerId === player.id) endTurn(state, now, 'drawer-left', effects);
  else if (state.phase === 'drawing' && everyoneGuessed(state)) endTurn(state, now, 'everyone-guessed', effects);
}

/** No-op returns the same state object, so timer polling never produces idle writes. */
export function advance(state: EngineState, now: number, random: Random = secureRandom): EngineResult {
  // Drawing batches arrive ~30 times/second. Copying the entire chat and word list
  // on every batch makes cost grow with room history, even when no timer is due.
  const wakeAt = nextWakeAt(state);
  const needsHost = !state.players.some(player => player.id === state.hostId && !player.departed)
    && state.players.some(player => player.connected && !player.departed);
  const canResume = state.phase === 'waiting'
    && state.players.filter(player => player.connected && !player.departed).length >= 2;
  if (!needsHost && !canResume && (wakeAt === null || now < wakeAt)) return { state, effects: [] };
  const draft = structuredClone(state);
  const effects: EngineEffect[] = [];
  let dirty = false;
  for (const player of draft.players) {
    if (!player.departed && !player.connected && player.disconnectedAt !== undefined && now >= player.disconnectedAt + RECONNECT_GRACE_MS) {
      depart(draft, player, now, effects);
      dirty = true;
    }
  }
  dirty = transferHost(draft, now) || dirty;
  if (draft.phase === 'choosing' && draft.turn && now >= draft.turn.deadline) {
    startDrawing(draft, 0, draft.turn.deadline, effects, random);
    dirty = true;
  }
  if (draft.phase === 'drawing' && draft.turn) {
    if (now >= draft.turn.deadline) {
      endTurn(draft, now, 'time-up', effects, draft.turn.deadline);
      dirty = true;
    } else {
      const level = Math.min(2, Math.floor((now - draft.turn.startedAt) * 3 / (draft.settings.drawSeconds * 1_000)));
      if (level > draft.turn.hintLevel) { draft.turn.hintLevel = level; dirty = true; }
    }
  }
  if ((draft.phase === 'reveal' && draft.turn && now >= draft.turn.deadline)
    || (draft.phase === 'waiting' && draft.players.filter((player) => player.connected && !player.departed).length >= 2)) {
    nextTurn(draft, now, effects, random);
    dirty = true;
  }
  return dirty ? changed(draft, effects, now) : { state, effects };
}

export function joinRoom(state: EngineState, identity: PlayerIdentity, now: number, random: Random = secureRandom): EngineResult {
  const advanced = advance(state, now, random);
  const parsed = identitySchema.safeParse({ name: identity.name, avatar: identity.avatar });
  if (!parsed.success) return fail(advanced, 'BAD_IDENTITY', 'Choose a valid name and avatar.');
  if (advanced.state.bannedIds.includes(identity.id)) return fail(advanced, 'BANNED', 'The host removed you from this room.');
  const existing = advanced.state.players.find((player) => player.id === identity.id && !player.departed);
  if (existing?.connected) return { ...advanced, reply: { kind: 'ok' } };
  if (!existing && advanced.state.players.filter((player) => !player.departed).length >= 12) return fail(advanced, 'ROOM_FULL', 'This room already has 12 players.');
  if (!existing && advanced.state.players.length >= MAX_ROOM_MEMBERS) return fail(advanced, 'ROOM_FULL', 'This room has reached its membership limit. Create a new room.');
  const draft = structuredClone(advanced.state);
  const player = draft.players.find((item) => item.id === identity.id && !item.departed);
  if (player) {
    player.connected = true;
    delete player.disconnectedAt;
    say(draft, `${player.name} reconnected.`, now);
  } else {
    // A seat returning after grace is a fresh entrant; avoid duplicate identities.
    draft.players = draft.players.filter((item) => item.id !== identity.id);
    if (draft.turn) draft.turn.eligibleIds = draft.turn.eligibleIds.filter((id) => id !== identity.id);
    const joinedRound = draft.phase === 'lobby' || draft.phase === 'results' ? 1 : draft.round + 1;
    draft.players.push(member({ ...identity, ...parsed.data }, now, joinedRound));
    say(draft, `${parsed.data.name} joined the room.`, now);
  }
  transferHost(draft, now);
  if (draft.phase === 'waiting' && draft.players.filter((item) => item.connected && !item.departed).length >= 2) nextTurn(draft, now, advanced.effects, random);
  return changed(draft, advanced.effects, now);
}

export const reconnectPlayer = joinRoom;

export function disconnectPlayer(state: EngineState, playerId: string, now: number, random: Random = secureRandom): EngineResult {
  const advanced = advance(state, now, random);
  const player = advanced.state.players.find((item) => item.id === playerId && !item.departed && item.connected);
  if (!player) return advanced;
  const draft = structuredClone(advanced.state);
  const target = draft.players.find((item) => item.id === playerId)!;
  target.connected = false;
  target.disconnectedAt = now;
  return changed(draft, advanced.effects, now);
}

export function leavePlayer(state: EngineState, playerId: string, now: number, random: Random = secureRandom): EngineResult {
  return applyCommand(state, playerId, { type: 'leave' }, now, random);
}

export function applyCommand(state: EngineState, actorId: string, command: EngineCommand, now: number, random: Random = secureRandom): EngineResult {
  const advanced = advance(state, now, random);
  const valid = engineCommandSchema.safeParse(command);
  if (!valid.success) return fail(advanced, 'BAD_COMMAND', 'That command is not valid.');
  command = valid.data;
  const actor = advanced.state.players.find((player) => player.id === actorId && !player.departed && player.connected);
  if (!actor) return fail(advanced, 'NOT_MEMBER', 'Reconnect to the room first.');
  const draft = structuredClone(advanced.state);
  const player = draft.players.find((item) => item.id === actorId)!;
  const effects = [...advanced.effects];
  const reject = (code: string, message: string) => fail(advanced, code, message);

  switch (command.type) {
    case 'settings': {
      if (actorId !== draft.hostId) return reject('FORBIDDEN', 'Only the host can change settings.');
      if (draft.phase !== 'lobby') return reject('BAD_PHASE', 'Settings are locked during a game.');
      const parsed = settingsInputSchema.safeParse(command.settings);
      if (!parsed.success) return reject('BAD_SETTINGS', 'Choose valid room settings.');
      const customWords = [...new Set(parsed.data.customWords.map(normalizeWord))];
      if (customWords.some((word) => [...word].length < 2 || [...word].length > 32 || !/[\p{L}\p{N}]/u.test(word) || /[\p{Cc}\p{Cf}]/u.test(word))) return reject('BAD_SETTINGS', 'Custom words must contain letters or numbers, with 2–32 characters.');
      if (parsed.data.wordMode === 'custom' && customWords.length < 3) return reject('BAD_SETTINGS', 'Add at least three different custom words.');
      const { rounds, drawSeconds, wordMode } = parsed.data;
      draft.settings = { rounds, drawSeconds, wordMode };
      draft.customWords = customWords;
      return changed(draft, effects, now);
    }
    case 'start': {
      if (actorId !== draft.hostId) return reject('FORBIDDEN', 'Only the host can start the game.');
      if (draft.phase !== 'lobby') return reject('BAD_PHASE', 'Return to the lobby before starting another game.');
      if (draft.players.filter((item) => !item.departed && item.connected).length < 2) return reject('NOT_ENOUGH_PLAYERS', 'Invite at least one more player to start.');
      if (wordPool(draft).length < 3) return reject('BAD_SETTINGS', 'Choose a list containing at least three words.');
      draft.gameId = `${draft.id}-${now}-g${++draft.gameCounter}`;
      draft.round = 0;
      draft.roundOrder = [];
      draft.turnIndex = 0;
      draft.turnCounter = 0;
      draft.players = draft.players.filter((item) => !item.departed);
      for (const item of draft.players) { item.score = 0; item.guessed = false; item.joinedRound = 1; }
      nextTurn(draft, now, effects, random);
      return changed(draft, effects, now);
    }
    case 'choose': {
      if (draft.phase !== 'choosing') return reject('BAD_PHASE', 'There is no word to choose right now.');
      if (!draft.turn || command.turnId !== draft.turn.id) return reject('STALE_TURN', 'That turn has ended.');
      if (actorId !== draft.turn.drawerId) return reject('FORBIDDEN', 'Only the drawer can choose a word.');
      if (!draft.turn.choices[command.index]) return reject('BAD_CHOICE', 'Choose one of the three words.');
      startDrawing(draft, command.index, now, effects, random);
      return changed(draft, effects, now);
    }
    case 'guess': {
      if (command.turnId && command.turnId !== draft.turn?.id) return reject('STALE_TURN', 'That turn has ended.');
      if (draft.phase === 'choosing' || draft.phase === 'drawing') {
        if (draft.turn?.drawerId === actorId || player.guessed) return reject('CHAT_LOCKED', 'Chat unlocks when this drawing ends.');
      }
      if (draft.phase === 'drawing' && draft.turn?.word) {
        if (!draft.turn.eligibleIds.includes(actorId)) return reject('SPECTATOR', 'You can guess from the next turn.');
        if (normalizeWord(command.text) === normalizeWord(draft.turn.word)) {
          const remaining = Math.max(0, draft.turn.deadline - now);
          const points = 100 + Math.floor(400 * remaining / (draft.settings.drawSeconds * 1_000));
          player.score += points;
          player.guessed = true;
          const drawer = draft.players.find((item) => item.id === draft.turn!.drawerId);
          if (drawer) drawer.score += 50;
          say(draft, `${player.name} guessed the word!`, now, 'success', player);
          if (everyoneGuessed(draft)) endTurn(draft, now, 'everyone-guessed', effects);
          return changed(draft, effects, now, { kind: 'correct', points });
        }
        say(draft, command.text, now, 'chat', player);
        return changed(draft, effects, now, { kind: isNearMiss(command.text, draft.turn.word) ? 'close' : 'chat' });
      }
      say(draft, command.text, now, 'chat', player);
      return changed(draft, effects, now, { kind: 'chat' });
    }
    case 'kick': {
      if (actorId !== draft.hostId) return reject('FORBIDDEN', 'Only the host can remove players.');
      if (actorId === command.playerId) return reject('FORBIDDEN', 'Use Leave room to leave your own room.');
      const target = draft.players.find((item) => item.id === command.playerId && !item.departed);
      if (!target) return reject('NOT_MEMBER', 'That player has already left.');
      draft.bannedIds.push(target.id);
      depart(draft, target, now, effects);
      return changed(draft, effects, now);
    }
    case 'leave': {
      depart(draft, player, now, effects);
      return changed(draft, effects, now);
    }
    case 'lobby': {
      if (actorId !== draft.hostId) return reject('FORBIDDEN', 'Only the host can return everyone to the lobby.');
      if (draft.phase !== 'results' && draft.phase !== 'waiting') return reject('BAD_PHASE', 'Finish the current game first.');
      if (draft.phase === 'waiting' && draft.gameId) gameEnded(draft, now, effects);
      draft.phase = 'lobby';
      draft.turn = null;
      draft.round = 0;
      draft.gameId = null;
      draft.roundOrder = [];
      draft.turnIndex = 0;
      draft.players = draft.players.filter((item) => !item.departed);
      for (const item of draft.players) { item.score = 0; item.guessed = false; item.joinedRound = 1; }
      return changed(draft, effects, now);
    }
  }
}

/** Useful to avoid polling if an orchestration layer schedules precise wakes. */
export function nextWakeAt(state: EngineState): number | null {
  const candidates = state.players.flatMap((player) => !player.departed && !player.connected && player.disconnectedAt !== undefined ? [player.disconnectedAt + RECONNECT_GRACE_MS] : []);
  if (state.turn && ['choosing', 'drawing', 'reveal'].includes(state.phase)) candidates.push(state.turn.deadline);
  if (state.phase === 'drawing' && state.turn && state.turn.hintLevel < 2) candidates.push(state.turn.startedAt + state.settings.drawSeconds * 1_000 * (state.turn.hintLevel + 1) / 3);
  return candidates.length ? Math.min(...candidates) : null;
}
