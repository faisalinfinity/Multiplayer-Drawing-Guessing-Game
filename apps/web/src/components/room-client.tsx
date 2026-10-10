'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Crown, DoorOpen, LoaderCircle, Play, Settings2, Users, Wifi, WifiOff, X } from 'lucide-react';
import type { Command, PlayerIdentity, PublicRoom, SettingsInput, Ack } from '@doodle/shared';
import { DEFAULT_SETTINGS } from '@doodle/shared';
import { Avatar, Brand } from './brand';
import { Button } from './ui/button';
import { GuestForm } from './guest-form';
import { useRoom } from '@/lib/use-room';
import { api } from '@/lib/utils';

type CommandFn = (command: Command, id?: string) => Promise<Ack>;

export function RoomClient({ roomId }: { roomId: string }) {
  const [identity, setIdentity] = useState<PlayerIdentity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [actionError, setActionError] = useState('');
  const [left, setLeft] = useState(false);
  const live = useRoom(roomId, !!identity && !left);
  useEffect(() => { void api<{ player: PlayerIdentity }>('/api/session').then(data => setIdentity(data.player)).catch(() => {}).finally(() => setLoaded(true)); }, []);
  async function action(command: Command) { const result = await live.command(command); setActionError(result.ok ? '' : result.error || 'Please try again.'); return result; }
  async function leave() { const result = await action({ type: 'leave' }); if (result.ok) setLeft(true); }
  if (!loaded) return <LoadingRoom />;
  if (live.kicked || left) return <div className="centered-page"><Brand /><section className="entry-card"><h1>{left ? 'See you next doodle.' : 'You’ve left the room.'}</h1><p className="muted">{left ? 'There’s always room for another game.' : 'The host removed you from this room.'}</p><Button asChild><Link href="/">Back to home</Link></Button></section></div>;
  if (!identity) return <div className="centered-page"><Brand /><section className="entry-card"><div className="card-eyebrow"><Users size={18} /> YOU’RE INVITED</div><h1>Your friends<br />are waiting.</h1><p className="muted">Choose a name. Bring your best bad drawings.</p><GuestForm onReady={async player => setIdentity(player)} label="Join this room" /></section></div>;
  if (!live.room) return <LoadingRoom error={live.error} />;
  const { room } = live;
  const host = room.hostId === live.playerId;
  const disabled = !live.connected || live.recovering;
  return <div className="room-page"><header className="room-header"><Brand small /><div className="room-header-right"><span className={`connection-label ${disabled ? 'offline' : ''}`}>{disabled ? <WifiOff size={14} /> : <Wifi size={14} />}{live.recovering ? 'Recovering room' : live.connected ? 'All connected' : 'Reconnecting…'}</span><span className="room-code">ROOM <strong>{room.id}</strong></span><button className="icon-button" aria-label="Leave room" onClick={() => void leave()} disabled={disabled}><DoorOpen size={18} /></button></div></header>
    {(live.error || actionError) && <div className="room-notice" role="alert">{live.error || actionError}{actionError && <button aria-label="Dismiss error" onClick={() => setActionError('')}><X size={15} /></button>}</div>}
    {!live.connected && <div className="connection-banner" role="status">Reconnecting to your room. Your seat and score are held for 30 seconds.</div>}
    {room.phase === 'lobby' ? <Lobby room={room} playerId={live.playerId} privateWords={live.privateState.customWords} action={action} disabled={disabled} /> : <main className="room-main"><div className="game-shell-placeholder"><h1>{room.phase === 'results' ? 'What a masterpiece.' : `Round ${room.round} of ${room.settings.rounds}`}</h1><p>The game is {room.phase}.</p>{host && room.phase === 'results' && <Button onClick={() => void action({ type: 'lobby' })}>Back to lobby</Button>}</div></main>}
    <footer className="room-footer"><span>A little drawing. A lot of fun.</span><span>Be kind. Get creative.</span></footer></div>;
}

function LoadingRoom({ error }: { error?: string }) { return <div className="centered-page"><Brand /><div className="loading-room"><LoaderCircle className="spin" size={26} /><h2>Pulling up a chair…</h2><p className="muted">{error || 'Getting your room ready.'}</p>{error && <Button asChild variant="secondary"><Link href="/">Back to home</Link></Button>}</div></div>; }

export function PlayerList({ room, playerId, action, disabled }: { room: PublicRoom; playerId: string; action: CommandFn; disabled: boolean }) {
  const players = room.players.filter(player => !player.departed).sort((a, b) => b.score - a.score);
  return <section className="players-card"><div className="panel-heading"><h2><Users size={17} /> The good company</h2><span className="count-badge">{players.length}/12</span></div><div className="players-list">{players.map((player, index) => <div key={player.id} className={`player-row ${player.id === playerId ? 'self' : ''} ${!player.connected ? 'player-offline' : ''} ${player.guessed ? 'player-guessed' : ''}`}><span className="player-rank">{room.phase === 'lobby' ? '' : index + 1}</span><Avatar index={player.avatar} name={player.name} /><div className="player-details"><span className="player-name">{player.name}{player.id === playerId && <small>you</small>}{player.id === room.hostId && <Crown size={12} className="crown" />}</span><span className="player-status">{!player.connected ? 'Reconnecting…' : room.turn?.drawerId === player.id ? 'Making a masterpiece' : player.guessed ? 'Got it!' : room.phase === 'lobby' ? 'Ready to doodle' : `${player.score.toLocaleString()} points`}</span></div>{player.guessed && <Check size={17} className="success-icon" />}{room.hostId === playerId && player.id !== playerId && <button disabled={disabled} className="kick-button" title={`Remove ${player.name}`} aria-label={`Remove ${player.name}`} onClick={() => void action({ type: 'kick', playerId: player.id })}><X size={13} /></button>}</div>)}</div>{room.phase === 'lobby' && players.length < 12 && <div className="empty-player"><div>+</div><span>There’s room for more friends</span></div>}</section>;
}

function Lobby({ room, playerId, privateWords, action, disabled }: { room: PublicRoom; playerId: string; privateWords?: string[]; action: CommandFn; disabled: boolean }) {
  const host = room.hostId === playerId;
  const [settings, setSettings] = useState<SettingsInput>({ ...DEFAULT_SETTINGS, customWords: [] });
  const [words, setWords] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (!dirty) { setSettings({ ...room.settings, customWords: privateWords || [] }); setWords((privateWords || []).join(', ')); } }, [room.settings, privateWords, dirty]);
  const players = room.players.filter(p => p.connected && !p.departed);
  function change<K extends keyof SettingsInput>(key: K, value: SettingsInput[K]) { setSettings(previous => ({ ...previous, [key]: value })); setDirty(true); setSaved(false); }
  async function save() { setBusy(true); const result = await action({ type: 'settings', settings: { ...settings, customWords: words.split(/[,\n]/).map(word => word.trim()).filter(Boolean) } }); setBusy(false); if (result.ok) { setDirty(false); setSaved(true); } }
  async function copy() { try { await navigator.clipboard.writeText(window.location.href); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopied(false); } }
  return <main className="room-main lobby-main"><div className="lobby-intro"><span className="eyebrow">THE MORE, THE MERRIER</span><h1>Let’s make a little mess.</h1><p>Your private room is ready. Send the link, gather your people, and let the doodling begin.</p></div><div className="lobby-grid"><div><PlayerList room={room} playerId={playerId} action={action} disabled={disabled} /><div className="lobby-tip"><span>✳</span><p>The best drawings aren’t always<br />the ones that look good.</p></div></div><section className="settings-card"><div className="panel-heading"><h2><Settings2 size={18} /> Make it your game</h2><span className="soft-tag">{host ? 'YOU’RE THE HOST' : 'HOST’S SETTINGS'}</span></div><div className="settings-fields"><label>Rounds<span>Everyone gets one turn per round.</span><select aria-label="Number of rounds" disabled={!host || disabled} value={settings.rounds} onChange={e => change('rounds', Number(e.target.value))}>{Array.from({ length: 10 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1} {i === 0 ? 'round' : 'rounds'}</option>)}</select></label><label>Time to draw<span>A little pressure makes great art.</span><select aria-label="Draw time" disabled={!host || disabled} value={settings.drawSeconds} onChange={e => change('drawSeconds', Number(e.target.value))}>{[15, 30, 45, 60, 80, 90, 120, 150, 180].map(value => <option key={value} value={value}>{value} seconds</option>)}</select></label><label className="wide-field">Word collection<span>Every round starts with a little inspiration.</span><select aria-label="Word collection" disabled={!host || disabled} value={settings.wordMode} onChange={e => change('wordMode', e.target.value as SettingsInput['wordMode'])}><option value="builtin">The good stuff · our word collection</option><option value="custom">Inside jokes · your words only</option><option value="mixed">A little of both · mixed collection</option></select></label>{host && settings.wordMode !== 'builtin' && <label className="wide-field">Your secret words<span>At least 3 unique words, separated by commas. Only you can see this list.</span><textarea aria-label="Custom words" rows={3} maxLength={16500} value={words} onChange={e => { setWords(e.target.value); setDirty(true); setSaved(false); }} placeholder="moonwalk, sleepy cat, birthday cake…" /></label>}</div>{host && <div className="settings-actions"><span>{saved ? <><Check size={14} /> Settings saved</> : dirty ? 'You have a few unsaved changes.' : 'All set for a good time.'}</span><Button variant="secondary" size="small" disabled={disabled || busy || !dirty} onClick={() => void save()}>Save settings</Button></div>}<div className="invite-strip"><div><span className="field-label">GOOD TIMES ARE BETTER SHARED</span><h3>Invite your favorite people.</h3></div><Button variant="secondary" onClick={() => void copy()}>{copied ? <Check size={17} /> : <Copy size={17} />}{copied ? 'Link copied!' : 'Copy invite link'}</Button></div><div className="start-area">{host ? <><Button className="full-width" disabled={disabled || players.length < 2 || dirty || busy} onClick={() => void action({ type: 'start' })}><Play size={18} fill="currentColor" /> Let’s get doodling</Button><p>{dirty ? 'Save your settings before starting.' : players.length < 2 ? 'Waiting for at least one more player to join.' : `${players.length} friends, ${settings.rounds} rounds. Let’s do this.`}</p></> : <div className="waiting-host"><LoaderCircle size={18} className="spin" /><span>Waiting for the host to start the fun.</span></div>}</div></section></div></main>;
}
