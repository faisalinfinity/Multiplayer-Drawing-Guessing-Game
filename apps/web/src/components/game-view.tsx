'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, ChevronRight, Clock3, Eye, Lightbulb, MessageCircle, Pencil, Send, Sparkles } from 'lucide-react';
import type { Ack, Command, DrawingEvent, DrawingOp, PrivateState, PublicRoom } from '@doodle/shared';
import { Avatar } from './brand';
import { DrawingCanvas } from './drawing-canvas';
import { Button } from './ui/button';

interface GameProps {
  room: PublicRoom;
  playerId: string;
  privateState: PrivateState;
  events: DrawingEvent[];
  offset: number;
  disabled: boolean;
  command: (value: Command, id?: string) => Promise<Ack>;
  players: React.ReactNode;
}

export function GameView({ room, playerId, privateState, events, offset, disabled, command, players }: GameProps) {
  const [now, setNow] = useState(Date.now());
  const [choiceError, setChoiceError] = useState('');
  const [choosing, setChoosing] = useState(false);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(interval); }, []);
  useEffect(() => { setChoosing(false); setChoiceError(''); }, [room.turn?.id, room.phase]);
  const turn = room.turn;
  const drawer = room.players.find(player => player.id === turn?.drawerId);
  const self = room.players.find(player => player.id === playerId);
  const isDrawer = turn?.drawerId === playerId;
  const eligible = turn?.eligibleIds.includes(playerId);
  const seconds = turn ? Math.max(0, Math.ceil((turn.deadline - now - offset) / 1000)) : 0;
  const duration = room.phase === 'choosing' ? 10 : room.phase === 'drawing' ? room.settings.drawSeconds : 5;
  const canDraw = room.phase === 'drawing' && isDrawer;
  const guessed = room.players.filter(player => turn?.eligibleIds.includes(player.id) && player.guessed).length;
  async function choose(index: number) {
    if (!turn) return;
    setChoosing(true); setChoiceError('');
    const ack = await command({ type: 'choose', turnId: turn.id, index });
    if (!ack.ok) { setChoiceError(ack.error || 'Please choose again.'); setChoosing(false); }
  }
  async function draw(op: DrawingOp, commandId: string) {
    if (!turn) return { ok: false, error: 'Wait for your turn.' };
    return command({ type: 'draw', turnId: turn.id, op }, commandId);
  }
  const instruction = room.phase === 'choosing' ? isDrawer ? 'Your masterpiece starts with a word.' : `${drawer?.name || 'The artist'} is finding inspiration…` : room.phase === 'reveal' ? 'One more for the gallery.' : room.phase === 'waiting' ? 'Good things are worth the wait.' : isDrawer ? 'This is your moment. Make a little magic.' : self?.guessed ? 'Nicely done! Enjoy the masterpiece.' : !eligible ? 'Settle in. You’ll guess from the next turn.' : 'Look closely. Think wildly. You’ve got this.';
  return <main className="room-main game-main">
    <div className="game-intro"><div><span className="eyebrow">ROUND {room.round} OF {room.settings.rounds}</span><h1>{isDrawer && room.phase === 'drawing' ? 'Time to make your mark.' : 'A picture. A thousand guesses.'}</h1></div><span className="game-intro-note"><Sparkles size={16} />{instruction}</span></div>
    <div className="game-grid"><aside className="game-players">{players}<div className="game-tip"><Lightbulb size={18} /><p>{isDrawer ? 'A picture’s worth a thousand words. Just don’t write any of them.' : 'The faster you guess, the more points you earn. Trust your first hunch.'}</p></div></aside>
      <section className="play-column"><div className="drawing-topbar"><div className="artist-info"><Avatar index={drawer?.avatar} name={drawer?.name} size={35} /><div><span>{room.phase === 'waiting' ? 'Waiting for friends' : `${drawer?.name || 'Your friend'}’s turn`}</span><small>{room.phase === 'choosing' ? 'choosing a word' : room.phase === 'reveal' ? 'a work of art' : isDrawer ? 'you’re the artist' : 'a masterpiece in progress'}</small></div></div><div className={`word-hint ${isDrawer ? 'drawer-hint' : ''}`} aria-label={isDrawer ? 'Your secret word' : 'Word hint'}><span>{room.phase === 'reveal' ? 'THE WORD WAS' : isDrawer && room.phase === 'drawing' ? 'YOU’RE DRAWING' : 'YOUR CLUE'}</span><strong data-testid={isDrawer && room.phase === 'drawing' ? 'secret-word' : 'word-hint'}>{room.phase === 'reveal' ? turn?.revealedWord : room.phase === 'drawing' ? isDrawer ? privateState.word || '…' : turn?.mask || '…' : '• • •'}</strong></div><div className={`countdown ${seconds <= 15 && room.phase === 'drawing' ? 'countdown-urgent' : ''}`} role="timer" aria-label={`${seconds} seconds remaining`}><Clock3 size={18} /><strong data-testid="countdown">{seconds}<small>s</small></strong></div></div>
        <div className="countdown-track"><div style={{ width: `${Math.min(100, (seconds / duration) * 100)}%` }} /></div>
        <div className="board-wrap"><DrawingCanvas events={events} turnId={turn?.id || null} canDraw={canDraw} onDraw={draw} disabled={disabled} />
          {room.phase === 'choosing' && <div className="board-overlay"><div className="overlay-icon mint"><Pencil size={28} /></div><span className="eyebrow">{isDrawer ? 'THE SPOTLIGHT IS YOURS' : 'A LITTLE SUSPENSE…'}</span><h2>{isDrawer ? 'What will you draw?' : `${drawer?.name || 'The artist'} is choosing.`}</h2><p>{isDrawer ? 'Pick a word. Bring it to life. Make them guess.' : 'Warm up those guessing muscles.'}</p>{isDrawer && <div className="word-choices">{privateState.choices?.map((word, index) => <Button key={`${index}-${word}`} data-testid="word-choice" variant="secondary" disabled={disabled || choosing} onClick={() => void choose(index)}>{word}<ChevronRight size={16} /></Button>) || <span className="muted">Fetching your inspiration…</span>}</div>}{choiceError && <p className="inline-error" role="alert">{choiceError}</p>}<small>Starting in {seconds} seconds</small></div>}
          {room.phase === 'reveal' && <div className="board-overlay reveal-overlay"><div className="reveal-card"><span className="eyebrow">THE BIG REVEAL</span><h2>{turn?.revealedWord || 'A masterpiece'}</h2><p>{turn?.reason === 'everyone-guessed' ? 'Everybody got it. What a team!' : turn?.reason?.includes('left') ? 'The artist stepped out. The show goes on.' : 'Pencils down. Another masterpiece complete.'}</p><div className="reveal-guessed"><Check size={17} />{guessed} {guessed === 1 ? 'friend guessed' : 'friends guessed'} it</div><small>Next up in {seconds}s</small></div></div>}
          {room.phase === 'waiting' && <div className="board-overlay"><div className="overlay-icon lavender"><Eye size={28} /></div><h2>A quick intermission.</h2><p>We need two connected players to keep the fun going.<br />The next turn starts when a friend returns.</p></div>}
        </div><div className="canvas-caption"><span><span className={`tiny-dot ${canDraw ? 'artist-dot' : ''}`} />{canDraw ? 'Your canvas · go wild' : room.phase === 'drawing' && !eligible ? 'Spectating · you’re in next turn' : 'Live canvas · a work in progress'}</span><span>{guessed}/{turn?.eligibleIds.length || 0} guessed</span></div>
      </section><ChatPanel room={room} playerId={playerId} disabled={disabled} command={command} /></div>
  </main>;
}

function ChatPanel({ room, playerId, disabled, command }: Pick<GameProps, 'room' | 'playerId' | 'disabled' | 'command'>) {
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState<{ text: string; kind: string } | null>(null);
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const self = room.players.find(player => player.id === playerId);
  const isDrawer = room.turn?.drawerId === playerId;
  const eligible = room.turn?.eligibleIds.includes(playerId);
  const canChat = !disabled && room.phase !== 'choosing' && room.phase !== 'waiting' && !(room.phase === 'drawing' && (isDrawer || self?.guessed || !eligible));
  const placeholder = disabled ? 'Reconnecting…' : room.phase === 'choosing' ? 'A new word is on its way…' : isDrawer && room.phase === 'drawing' ? 'Let your drawing do the talking.' : self?.guessed && room.phase === 'drawing' ? 'You got it. Keep the secret!' : !eligible && room.phase === 'drawing' ? 'You can guess next turn.' : room.phase === 'waiting' ? 'Waiting for friends…' : room.phase === 'drawing' ? 'Type your best guess…' : 'Say something nice…';
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [room.chat.length, feedback]);
  useEffect(() => { setFeedback(null); setText(''); }, [room.turn?.id]);
  useEffect(() => { if (!feedback) return; const timeout = setTimeout(() => setFeedback(null), 4500); return () => clearTimeout(timeout); }, [feedback]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!text.trim() || !canChat || sending) return;
    setSending(true);
    const guess = text;
    setText('');
    const result = await command({ type: 'guess', ...(room.turn ? { turnId: room.turn.id } : {}), text: guess });
    setSending(false);
    if (!result.ok) { setFeedback({ text: result.error || 'Try again in a moment.', kind: 'error' }); setText(guess); }
    else if (result.feedback === 'close') setFeedback({ text: 'So close! You’re just one little letter away.', kind: 'close' });
    else if (result.feedback === 'correct') setFeedback({ text: `You got it! +${result.points || 0} points. Keep it a secret.`, kind: 'correct' });
    inputRef.current?.focus();
  }
  return <section className="chat-card"><div className="panel-heading"><h2><MessageCircle size={17} /> The guessing corner</h2><span className="chat-live-dot" /></div><div className="chat-messages" role="log" aria-label="Game chat" aria-live="polite"><div className="chat-welcome"><span>👋</span><p>Wild guesses welcome.<br />Good vibes only.</p></div>{room.chat.map(message => <div className={`chat-message chat-${message.kind}`} key={message.id}>{message.kind === 'success' && <Check size={13} />}{message.kind === 'chat' ? <p><strong>{message.name}<span>:</span></strong> {message.text}</p> : <p>{message.text}</p>}</div>)}{feedback && <div className={`guess-feedback feedback-${feedback.kind}`} role="status">{feedback.kind === 'close' ? <Lightbulb size={15} /> : feedback.kind === 'correct' ? <Check size={15} /> : null}<span>{feedback.text}</span></div>}<div ref={endRef} /></div><form className="chat-form" onSubmit={submit}><div className="chat-input-wrap"><input ref={inputRef} aria-label="Your guess" data-testid="guess-input" autoComplete="off" maxLength={200} placeholder={placeholder} disabled={!canChat} value={text} onChange={event => setText(event.target.value)} /><button type="submit" aria-label="Send guess" disabled={!canChat || !text.trim() || sending}><Send size={16} /></button></div><p>{isDrawer && room.phase === 'drawing' ? 'Your secret word stays between us.' : self?.guessed && room.phase === 'drawing' ? 'Give everyone a chance to guess.' : 'Be kind. No spoilers. Have fun.'}</p></form></section>;
}
