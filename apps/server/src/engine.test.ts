import { describe, expect, it } from 'vitest';
import type { EngineCommand, PlayerIdentity } from '@doodle/shared';
import {
  advance, applyCommand, CHOICE_MS, createRoom, disconnectPlayer, isNearMiss,
  joinRoom, leavePlayer, nextWakeAt, normalizeWord, privateState, publicState,
  RECONNECT_GRACE_MS, REVEAL_MS, type EngineResult, type EngineState,
} from './engine.js';

const now = 1_000_000;
const rng = () => 0.25;
const alice: PlayerIdentity = { id: 'alice', name: 'Alice', avatar: 0 };
const bob: PlayerIdentity = { id: 'bob', name: 'Bob', avatar: 1 };
const carol: PlayerIdentity = { id: 'carol', name: 'Carol', avatar: 2 };
const dave: PlayerIdentity = { id: 'dave', name: 'Dave', avatar: 3 };

function ok(result: EngineResult): EngineState {
  expect(result.error).toBeUndefined();
  return result.state;
}

function command(state: EngineState, actor: string, value: EngineCommand, at = now): EngineState {
  return ok(applyCommand(state, actor, value, at, rng));
}

function lobby(players = 3, rounds = 1, drawSeconds = 15): EngineState {
  let state = createRoom('room-test', alice, now);
  if (players >= 2) state = ok(joinRoom(state, bob, now, rng));
  if (players >= 3) state = ok(joinRoom(state, carol, now, rng));
  return command(state, alice.id, { type: 'settings', settings: { rounds, drawSeconds, wordMode: 'custom', customWords: ['elephant', 'rainbow', 'ice cream'] } });
}

function choosing(players = 3, rounds = 1, drawSeconds = 15): EngineState {
  return command(lobby(players, rounds, drawSeconds), alice.id, { type: 'start' });
}

function drawing(players = 3, rounds = 1, drawSeconds = 15): EngineState {
  const state = choosing(players, rounds, drawSeconds);
  return command(state, alice.id, { type: 'choose', turnId: state.turn!.id, index: 0 });
}

function guess(state: EngineState, id: string, text = state.turn!.word!, at = now + 1_000): EngineResult {
  return applyCommand(state, id, { type: 'guess', turnId: state.turn!.id, text }, at, rng);
}

describe('server-authoritative words, phases and points', () => {
  it('keeps choices, vocabulary, private timing and selected words outside public state', () => {
    const selection = choosing();
    expect(privateState(selection, alice.id).choices).toHaveLength(3);
    expect(privateState(selection, bob.id)).toEqual({});
    expect(publicState(selection).turn!.mask).toBe('');
    expect(JSON.stringify(publicState(selection))).not.toMatch(/elephant|rainbow|ice cream|customWords|choices|hintOrder|disconnectedAt/);

    const state = drawing();
    expect(privateState(state, alice.id)).toEqual({ word: state.turn!.word });
    expect(privateState(state, bob.id)).toEqual({});
    expect(privateState(state, 'intruder')).toEqual({});
    expect(JSON.stringify(publicState(state))).not.toContain(state.turn!.word!);
    expect(publicState(state).turn!.mask).toMatch(/_/);
    expect(publicState(state).players[0]).not.toHaveProperty('joinedRound');
  });

  it('only reveals custom words to the current lobby host', () => {
    const state = lobby();
    expect(privateState(state, alice.id).customWords).toEqual(['elephant', 'rainbow', 'ice cream']);
    expect(privateState(state, bob.id).customWords).toBeUndefined();
    expect(privateState(choosing(), alice.id).customWords).toBeUndefined();
  });

  it('requires two connected players and a host to start', () => {
    expect(applyCommand(lobby(1), alice.id, { type: 'start' }, now).error?.code).toBe('NOT_ENOUGH_PLAYERS');
    expect(applyCommand(lobby(), bob.id, { type: 'start' }, now).error?.code).toBe('FORBIDDEN');
    const disconnected = ok(disconnectPlayer(lobby(2), bob.id, now));
    expect(applyCommand(disconnected, alice.id, { type: 'start' }, now).error?.code).toBe('NOT_ENOUGH_PLAYERS');
  });

  it('auto-selects after ten seconds, and advances no earlier', () => {
    const state = choosing();
    expect(advance(state, now + CHOICE_MS - 1, rng).state).toBe(state);
    const result = advance(state, now + CHOICE_MS, rng);
    expect(result.state.phase).toBe('drawing');
    expect(result.state.turn!.word).toBe(state.turn!.choices[0]);
    expect(result.state.turn!.startedAt).toBe(now + CHOICE_MS);
    expect(result.state.turn!.deadline).toBe(now + CHOICE_MS + 15_000);
    expect(result.effects.map((effect) => effect.type)).toEqual(['drawing-started']);
  });

  it('checks drawer privilege, phase and stale turn IDs on selection', () => {
    const state = choosing();
    expect(applyCommand(state, bob.id, { type: 'choose', turnId: state.turn!.id, index: 0 }, now).error?.code).toBe('FORBIDDEN');
    expect(applyCommand(state, alice.id, { type: 'choose', turnId: 'stale', index: 0 }, now).error?.code).toBe('STALE_TURN');
    expect(applyCommand(drawing(), alice.id, { type: 'choose', turnId: state.turn!.id, index: 0 }, now).error?.code).toBe('BAD_PHASE');
  });

  it('scores using server receipt time and changes both awards in the same state', () => {
    const state = drawing();
    const result = guess(state, bob.id, state.turn!.word, now + 3_000);
    expect(result.reply).toEqual({ kind: 'correct', points: 420 });
    expect(result.state.players.find((player) => player.id === bob.id)?.score).toBe(420);
    expect(result.state.players.find((player) => player.id === alice.id)?.score).toBe(50);
    expect(result.state.players.find((player) => player.id === bob.id)?.guessed).toBe(true);
    expect(result.state.phase).toBe('drawing');
    expect(state.players.every((player) => player.score === 0)).toBe(true);
    expect(result.state.chat.filter((message) => message.kind === 'chat')).toEqual([]);
    expect(JSON.stringify(publicState(result.state))).not.toContain(state.turn!.word!);
  });

  it('blocks subsequent free text from correct guessers and the drawer', () => {
    const state = drawing();
    const success = ok(guess(state, bob.id));
    expect(guess(success, bob.id, 'The answer is elephant').error?.code).toBe('CHAT_LOCKED');
    expect(guess(success, alice.id, 'hint').error?.code).toBe('CHAT_LOCKED');
    expect(applyCommand(choosing(), alice.id, { type: 'guess', text: 'hint' }, now).error?.code).toBe('CHAT_LOCKED');
  });

  it('ends once everyone eligible has guessed, without duplicated points', () => {
    let state = drawing();
    state = ok(guess(state, bob.id));
    const result = guess(state, carol.id, state.turn!.word, now + 2_000);
    expect(result.state.phase).toBe('reveal');
    expect(result.effects.filter((effect) => effect.type === 'turn-ended')).toHaveLength(1);
    expect(publicState(result.state).turn!.revealedWord).toBe(state.turn!.word);
    expect(result.state.players[0]!.score).toBe(100);
    const again = ok(guess(result.state, carol.id, state.turn!.word, now + 2_001));
    expect(again.players.map((player) => player.score)).toEqual(result.state.players.map((player) => player.score));
  });

  it('never awards a guess received on or after the deadline', () => {
    const state = drawing();
    const result = guess(state, bob.id, state.turn!.word, state.turn!.deadline);
    expect(result.state.phase).toBe('reveal');
    expect(result.state.players.every((player) => player.score === 0)).toBe(true);
    expect(result.reply?.kind).not.toBe('correct');
    expect(result.effects[0]).toMatchObject({ type: 'turn-ended', reason: 'time-up', endedAt: state.turn!.deadline });
  });

  it('advances overdue state even when the incoming command is rejected', () => {
    const state = choosing();
    const result = applyCommand(state, alice.id, { type: 'choose', turnId: state.turn!.id, index: 1 }, state.turn!.deadline, rng);
    expect(result.error?.code).toBe('BAD_PHASE');
    expect(result.state.phase).toBe('drawing');
    expect(result.state).not.toBe(state);
    expect(result.effects[0]?.type).toBe('drawing-started');
  });

  it('reveals hints at thirds and always leaves a letter hidden', () => {
    let state = drawing();
    const baseMask = publicState(state).turn!.mask;
    expect(advance(state, now + 4_999, rng).state).toBe(state);
    state = ok(advance(state, now + 5_000, rng));
    const first = publicState(state).turn!.mask;
    expect(first).not.toBe(baseMask);
    expect(first).toContain('_');
    state = ok(advance(state, now + 10_000, rng));
    const second = publicState(state).turn!.mask;
    expect(second).not.toBe(first);
    expect(second).toContain('_');
    expect(state.turn!.hintLevel).toBe(2);
  });

  it('normalizes Unicode, casing and internal whitespace for correct guesses', () => {
    expect(normalizeWord('  ＩＣＥ \t CREAM ')).toBe('ice cream');
    let state = lobby();
    state = command(state, alice.id, { type: 'settings', settings: { ...state.settings, customWords: ['café', 'ice cream', 'zebra'] } });
    state = command(state, alice.id, { type: 'start' });
    const index = state.turn!.choices.indexOf('café');
    state = command(state, alice.id, { type: 'choose', turnId: state.turn!.id, index });
    expect(guess(state, bob.id, 'CAFE\u0301').reply?.kind).toBe('correct');
  });

  it('sends near-miss feedback privately while preserving the public wrong guess', () => {
    const state = drawing();
    const text = `${state.turn!.word!.slice(0, -1)}x`;
    const result = guess(state, bob.id, text);
    expect(result.reply?.kind).toBe('close');
    expect(result.state.chat.at(-1)).toMatchObject({ text, kind: 'chat', playerId: bob.id });
    expect(JSON.stringify(publicState(result.state))).not.toContain('close');
    expect(result.state.players[1]!.score).toBe(0);
  });

  it.each([
    ['elephan', 'elephant', true], ['elephants', 'elephant', true], ['elephanx', 'elephant', true],
    ['elaphant', 'elephant', true], ['elaphanx', 'elephant', false], ['elephant', 'elephant', false],
    ['ct', 'cat', false], ['caféx', 'café', true], ['anything', 'elephant', false],
  ])('checks a near miss: %s / %s', (input, word, expected) => {
    expect(isNearMiss(input, word)).toBe(expected);
  });
});

describe('rotation, late joins and match completion', () => {
  it('gives each player one turn per round, then produces one completed game', () => {
    let state = choosing(3, 2);
    let clock = now;
    const drawers: string[] = [];
    const rounds: number[] = [];
    const completed: EngineResult['effects'] = [];
    for (let turn = 0; turn < 6; turn++) {
      expect(state.phase).toBe('choosing');
      drawers.push(state.turn!.drawerId);
      rounds.push(state.round);
      state = command(state, state.turn!.drawerId, { type: 'choose', turnId: state.turn!.id, index: 0 }, clock);
      clock = state.turn!.deadline;
      state = ok(advance(state, clock, rng));
      clock += REVEAL_MS;
      const result = advance(state, clock, rng);
      completed.push(...result.effects);
      state = ok(result);
    }
    expect(drawers).toEqual(['alice', 'bob', 'carol', 'alice', 'bob', 'carol']);
    expect(rounds).toEqual([1, 1, 1, 2, 2, 2]);
    expect(state.phase).toBe('results');
    expect(state.turn).toBeNull();
    expect(state.completedGames).toEqual([state.gameId]);
    expect(completed.filter((effect) => effect.type === 'game-ended')).toHaveLength(1);
    expect(advance(state, clock + 10_000, rng).state).toBe(state);
  });

  it('allows late joiners to guess next turn and draw next round only', () => {
    let state = drawing(3, 2);
    state = ok(joinRoom(state, dave, now + 1_000, rng));
    expect(state.turn!.eligibleIds).not.toContain(dave.id);
    expect(guess(state, dave.id).error?.code).toBe('SPECTATOR');
    let clock = state.turn!.deadline;
    state = ok(advance(state, clock, rng));
    clock += REVEAL_MS;
    state = ok(advance(state, clock, rng));
    expect(state.turn!.drawerId).toBe(bob.id);
    expect(state.turn!.eligibleIds).toContain(dave.id);
    expect(state.roundOrder).not.toContain(dave.id);
    state = command(state, bob.id, { type: 'choose', turnId: state.turn!.id, index: 0 }, clock);
    expect(guess(state, dave.id, state.turn!.word, clock + 1).reply?.kind).toBe('correct');
    state = ok(advance(state, state.turn!.deadline, rng));
    clock = state.turn!.deadline;
    state = ok(advance(state, clock, rng));
    expect(state.turn!.drawerId).toBe(carol.id);
    state = command(state, carol.id, { type: 'choose', turnId: state.turn!.id, index: 0 }, clock);
    state = ok(advance(state, state.turn!.deadline, rng));
    state = ok(advance(state, state.turn!.deadline, rng));
    expect(state.round).toBe(2);
    expect(state.roundOrder).toEqual(['alice', 'bob', 'carol', 'dave']);
  });

  it('keeps replay game IDs when the host returns to the lobby and starts again', () => {
    let state = choosing(2);
    for (let turn = 0; turn < 2; turn++) {
      state = ok(advance(state, state.turn!.deadline + 15_000, rng));
      state = ok(advance(state, state.turn!.deadline, rng));
    }
    const gameId = state.gameId;
    expect(state.phase).toBe('results');
    state = command(state, alice.id, { type: 'lobby' }, now + 100_000);
    expect(state.phase).toBe('lobby');
    expect(state.gameId).toBeNull();
    expect(state.completedGames).toEqual([gameId]);
    state = command(state, alice.id, { type: 'start' }, now + 101_000);
    expect(state.gameId).not.toBe(gameId);
    expect(state.players.every((player) => player.score === 0)).toBe(true);
  });
});

describe('departures, reconnect grace and persisted restart state', () => {
  it('keeps a successful guesser score after a reconnect at 29 seconds', () => {
    let state = drawing(3, 2, 80);
    state = ok(guess(state, bob.id));
    const score = state.players[1]!.score;
    state = ok(disconnectPlayer(state, bob.id, now + 1_000, rng));
    state = ok(joinRoom(state, bob, now + 30_000, rng));
    expect(state.players[1]).toMatchObject({ score, connected: true, guessed: true, departed: false });
    expect(state.players[1]!.disconnectedAt).toBeUndefined();
  });

  it('resets the seat after the 30-second grace and treats the return as late', () => {
    let state = drawing(3, 2, 80);
    state = ok(guess(state, bob.id));
    state = ok(disconnectPlayer(state, bob.id, now + 1_000, rng));
    state = ok(advance(state, now + 31_001, rng));
    expect(state.players.find((player) => player.id === bob.id)?.departed).toBe(true);
    state = ok(joinRoom(state, bob, now + 31_002, rng));
    expect(state.players.find((player) => player.id === bob.id)).toMatchObject({ score: 0, guessed: false, connected: true, joinedRound: 2 });
    expect(state.turn!.eligibleIds).not.toContain(bob.id);
    expect(guess(state, bob.id, state.turn!.word, now + 31_003).error?.code).toBe('SPECTATOR');
  });

  it('leaves the clock running while a drawer is disconnected, restoring control on return', () => {
    let state = drawing(3, 2, 80);
    const deadline = state.turn!.deadline;
    const word = state.turn!.word;
    state = ok(disconnectPlayer(state, alice.id, now + 1_000, rng));
    expect(state.phase).toBe('drawing');
    state = ok(joinRoom(state, alice, now + 30_000, rng));
    expect(state.phase).toBe('drawing');
    expect(state.turn!.deadline).toBe(deadline);
    expect(privateState(state, alice.id).word).toBe(word);
    expect(state.hostId).toBe(alice.id);
  });

  it('ends a drawer turn and transfers the host exactly when grace expires', () => {
    let state = drawing(3, 2, 80);
    state = ok(disconnectPlayer(state, alice.id, now, rng));
    expect(advance(state, now + RECONNECT_GRACE_MS - 1, rng).state.phase).toBe('drawing');
    const result = advance(state, now + RECONNECT_GRACE_MS, rng);
    expect(result.state.phase).toBe('reveal');
    expect(result.state.hostId).toBe(bob.id);
    expect(result.effects).toContainEqual(expect.objectContaining({ type: 'turn-ended', reason: 'drawer-left' }));
  });

  it('immediately recovers from an explicit drawer leave', () => {
    const state = drawing();
    const result = leavePlayer(state, alice.id, now + 1_000, rng);
    expect(result.state.phase).toBe('reveal');
    expect(result.state.hostId).toBe(bob.id);
    expect(result.state.players[0]!.departed).toBe(true);
    const resumed = ok(advance(result.state, now + 1_000 + REVEAL_MS, rng));
    expect(resumed.turn!.drawerId).toBe(bob.id);
  });

  it('waits between turns with fewer than two connected players and resumes on return', () => {
    let state = drawing(3, 2, 15);
    state = ok(disconnectPlayer(state, bob.id, now, rng));
    state = ok(disconnectPlayer(state, carol.id, now, rng));
    state = ok(advance(state, now + 15_000, rng));
    state = ok(advance(state, now + 15_000 + REVEAL_MS, rng));
    expect(state.phase).toBe('waiting');
    expect(state.turn).toBeNull();
    state = ok(joinRoom(state, bob, now + 20_000, rng));
    expect(state.phase).toBe('choosing');
    expect(state.turn!.drawerId).toBe(bob.id);
  });

  it('retains persisted choice, hint order, scores and deadlines after serialization', () => {
    let state = drawing(3, 2, 80);
    state = ok(guess(state, bob.id));
    const persisted = JSON.parse(JSON.stringify(state)) as EngineState;
    const resumed = advance(persisted, now + 10_000, rng);
    expect(resumed.state).toBe(persisted);
    expect(resumed.state.turn).toEqual(state.turn);
    expect(resumed.state.players).toEqual(state.players);
    const expired = advance(persisted, now + 100_000, rng);
    expect(expired.state.phase).toBe('reveal');
    expect(expired.effects.filter((effect) => effect.type === 'turn-ended')).toHaveLength(1);
    expect(advance(expired.state, now + 100_001, rng).effects).toEqual([]);
  });

  it('resolves a choosing deadline and expired drawing after a long server outage', () => {
    const state = choosing();
    const result = advance(state, now + 60_000, rng);
    expect(result.state.phase).toBe('reveal');
    expect(result.effects.map((effect) => effect.type)).toEqual(['drawing-started', 'turn-ended']);
    expect(result.effects[1]).toMatchObject({ endedAt: now + CHOICE_MS + 15_000 });
    expect(result.state.turn!.deadline).toBe(now + 60_000 + REVEAL_MS);
  });

  it('does not let a departed offline host reclaim ownership on return', () => {
    let state = lobby();
    state = ok(disconnectPlayer(state, alice.id, now, rng));
    state = ok(advance(state, now + RECONNECT_GRACE_MS, rng));
    expect(state.hostId).toBe(bob.id);
    state = ok(joinRoom(state, alice, now + RECONNECT_GRACE_MS + 1, rng));
    expect(state.hostId).toBe(bob.id);
  });
});

describe('authorization, limits and value isolation', () => {
  it('restricts settings to the host in the lobby and requires three unique custom words', () => {
    const state = lobby();
    const update: EngineCommand = { type: 'settings', settings: { ...state.settings, customWords: ['apple', ' APPLE ', 'banana'] } };
    expect(applyCommand(state, bob.id, update, now).error?.code).toBe('FORBIDDEN');
    expect(applyCommand(state, alice.id, update, now).error?.code).toBe('BAD_SETTINGS');
    expect(applyCommand(drawing(), alice.id, update, now).error?.code).toBe('BAD_PHASE');
  });

  it('rejects forged points and invalid commands even when invoked without transport validation', () => {
    const state = drawing();
    const result = applyCommand(state, bob.id, { type: 'guess', text: state.turn!.word, points: 99999 } as unknown as EngineCommand, now);
    expect(result.error?.code).toBe('BAD_COMMAND');
    expect(result.state).toBe(state);
    expect(applyCommand(state, 'stranger', { type: 'guess', text: 'hello' }, now).error?.code).toBe('NOT_MEMBER');
    expect(applyCommand(state, bob.id, { type: 'guess', text: 'x'.repeat(201) }, now).error?.code).toBe('BAD_COMMAND');
  });

  it('enforces the twelve-seat limit including reconnect reservations', () => {
    let state = lobby();
    for (let i = 3; i < 12; i++) state = ok(joinRoom(state, { id: `player-${i}`, name: `Player ${i}`, avatar: 0 }, now, rng));
    state = ok(disconnectPlayer(state, bob.id, now, rng));
    expect(joinRoom(state, dave, now + 1, rng).error?.code).toBe('ROOM_FULL');
    expect(joinRoom(state, bob, now + 1, rng).error).toBeUndefined();
  });

  it('supports host removal, disallows self-kicking, and rejects re-entry by the removed session', () => {
    let state = drawing();
    expect(applyCommand(state, bob.id, { type: 'kick', playerId: carol.id }, now).error?.code).toBe('FORBIDDEN');
    expect(applyCommand(state, alice.id, { type: 'kick', playerId: alice.id }, now).error?.code).toBe('FORBIDDEN');
    state = command(state, alice.id, { type: 'kick', playerId: bob.id });
    expect(state.players[1]!.departed).toBe(true);
    expect(joinRoom(state, bob, now + 1, rng).error?.code).toBe('BANNED');
    expect(guess(state, bob.id).error?.code).toBe('NOT_MEMBER');
  });

  it('bounds chat history and treats submitted markup as plain text data', () => {
    let state = lobby();
    for (let i = 0; i < 105; i++) state = command(state, bob.id, { type: 'guess', text: `<script>${i}</script>` });
    expect(state.chat).toHaveLength(100);
    expect(state.chat.at(-1)!.text).toBe('<script>104</script>');
    expect(new Set(state.chat.map((message) => message.id)).size).toBe(100);
  });

  it('does not expose mutable engine references through either projection', () => {
    const state = choosing();
    const snapshot = publicState(state);
    snapshot.players[0]!.score = 99_999;
    snapshot.settings.rounds = 10;
    snapshot.turn!.eligibleIds.length = 0;
    snapshot.chat[0]!.text = 'changed';
    const privateSnapshot = privateState(state, alice.id);
    privateSnapshot.choices![0] = 'changed';
    expect(state.players[0]!.score).toBe(0);
    expect(state.settings.rounds).toBe(1);
    expect(state.turn!.eligibleIds).toHaveLength(2);
    expect(state.chat[0]!.text).not.toBe('changed');
    expect(state.turn!.choices[0]).not.toBe('changed');
  });

  it('provides the next timer boundary and returns identical references for idle work', () => {
    expect(nextWakeAt(lobby())).toBeNull();
    expect(nextWakeAt(choosing())).toBe(now + CHOICE_MS);
    expect(nextWakeAt(drawing())).toBe(now + 5_000);
    const state = lobby();
    expect(advance(state, now + 1).state).toBe(state);
    expect(disconnectPlayer(state, 'absent', now).state).toBe(state);
    expect(joinRoom(state, alice, now).state).toBe(state);
  });
});
