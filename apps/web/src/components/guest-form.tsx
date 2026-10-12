'use client';

import { useState, type FormEvent } from 'react';
import { ArrowRight, LoaderCircle, Shuffle } from 'lucide-react';
import type { PlayerIdentity } from '@doodle/shared';
import { Avatar } from './brand';
import { Button } from './ui/button';
import { api } from '@/lib/utils';

export function GuestForm({ onReady, label = 'Let’s play', initial }: { onReady: (player: PlayerIdentity) => Promise<void>; label?: string; initial?: PlayerIdentity | null }) {
  const [name, setName] = useState(initial?.name || '');
  const [avatar, setAvatar] = useState(initial?.avatar ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const result = await api<{ player: PlayerIdentity }>('/api/session', { name: name.trim(), avatar }); await onReady(result.player); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not join. Please try again.'); setBusy(false); }
  }
  return <form onSubmit={submit} className="guest-form">
    <div className="avatar-picker"><div className="avatar-feature"><Avatar index={avatar} name={name} size={84} /><button type="button" className="shuffle-avatar" onClick={() => setAvatar((avatar + 1) % 8)} aria-label="Change avatar"><Shuffle size={14} /></button></div><div><span className="field-label">PICK YOUR LITTLE SIDEKICK</span><div className="avatar-options">{Array.from({ length: 8 }, (_, index) => <button key={index} type="button" className={avatar === index ? 'selected' : ''} aria-label={`Choose avatar ${index + 1}`} aria-pressed={avatar === index} onClick={() => setAvatar(index)}><Avatar index={index} size={27} /></button>)}</div></div></div>
    <label htmlFor="player-name" className="field-label">WHAT SHOULD WE CALL YOU?</label>
    <input id="player-name" name="name" placeholder="Your excellent nickname" autoComplete="nickname" maxLength={20} required pattern="[\p{L}\p{N} _'\-]+" value={name} onChange={event => setName(event.target.value)} />
    {error && <p role="alert" className="inline-error">{error}</p>}
    <Button className="full-width" type="submit" disabled={busy || !name.trim()}>{busy ? <LoaderCircle size={19} className="spin" /> : <>{label}<ArrowRight size={19} /></>}</Button>
    <p className="form-footnote">No sign-up. Just bring your imagination.</p>
  </form>;
}
