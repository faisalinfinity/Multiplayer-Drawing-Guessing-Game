'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Heart, Link as LinkIcon, Pencil, Sparkles, Trophy, Users } from 'lucide-react';
import type { PlayerIdentity } from '@doodle/shared';
import { Brand, DoodleArt, Avatar } from '@/components/brand';
import { GuestForm } from '@/components/guest-form';
import { api } from '@/lib/utils';

export default function Home() {
  const router = useRouter();
  const [initial, setInitial] = useState<PlayerIdentity | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [join, setJoin] = useState(false);
  const [roomCode, setRoomCode] = useState('');
  useEffect(() => { void api<{ player: PlayerIdentity }>('/api/session').then(data => setInitial(data.player)).catch(() => {}).finally(() => setLoaded(true)); }, []);
  async function enter() {
    if (join) {
      const trimmed = roomCode.trim().replace(/\/$/, '');
      const id = trimmed.includes('/') ? trimmed.split('/').at(-1) : trimmed;
      if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Enter a room code or a complete invitation link.');
      await api(`/api/rooms/${encodeURIComponent(id)}`); router.push(`/room/${id}`);
    } else { const { roomId } = await api<{ roomId: string }>('/api/rooms', {}); router.push(`/room/${roomId}`); }
  }
  return <div className="home-page">
    <header className="site-header"><Brand /><nav><span className="header-note"><span className="tiny-dot" /> Made for a good time</span><a className="text-link" href="#how-to-play">How to play <ArrowRight size={15} /></a></nav></header>
    <main>
      <section className="hero-section"><div className="hero-copy"><div className="eyebrow"><Sparkles size={15} /> LESS SCROLLING. MORE SCRIBBLING.</div><h1>Bad drawings.<br /><span className="handwritten-word">Great</span> company.</h1><p className="hero-description">A little imagination. A few wild guesses.<br />Your next favorite game night starts here.</p><DoodleArt /><div className="hero-social"><div className="avatar-stack">{[2, 0, 3, 1].map(n => <Avatar key={n} index={n} size={36} />)}</div><span>2–12 friends <i>·</i> Endless questionable art</span></div></div>
      <div className="entry-wrap"><div className="entry-sticker">EVERYONE’S AN ARTIST*</div><section className="entry-card"><div className="card-eyebrow"><Pencil size={18} /> YOUR CANVAS IS WAITING</div><h2>Come on in.</h2><p className="muted">No drawing skills required. Seriously.</p><div className="entry-tabs" role="tablist" aria-label="Choose how to play"><button role="tab" aria-selected={!join} onClick={() => setJoin(false)}><Sparkles size={15} />Create a room</button><button role="tab" aria-selected={join} onClick={() => setJoin(true)}><LinkIcon size={15} />Join friends</button></div>{join && <div className="join-code"><label className="field-label" htmlFor="room-code">ROOM CODE OR INVITE LINK</label><input id="room-code" placeholder="Paste your invitation here" value={roomCode} onChange={e => setRoomCode(e.target.value)} /></div>}{loaded ? <GuestForm initial={initial} onReady={enter} label={join ? 'Join the fun' : 'Create a private room'} /> : <div className="form-skeleton" aria-label="Loading your profile" />}</section><p className="artist-footnote">*Even if your cat looks like a potato.</p></div></section>
      <section id="how-to-play" className="how-section"><div className="section-heading"><span className="eyebrow">BIG FUN. TINY LEARNING CURVE.</span><h2>Three steps to “what is that?”</h2></div><div className="how-grid"><article><div className="step-icon mint"><Users size={26} /><span>01</span></div><h3>Gather your people</h3><p>Create a room and send the link. <br />Faraway friends, one little room.</p></article><article><div className="step-icon peach"><Pencil size={26} /><span>02</span></div><h3>Make your masterpiece</h3><p>Pick a secret word and draw it. <br />Artistic talent? Entirely optional.</p></article><article><div className="step-icon lavender"><Trophy size={26} /><span>03</span></div><h3>Guess it. Celebrate it.</h3><p>Guess faster, score bigger. <br />Then it’s the next artist’s turn.</p></article></div></section>
    </main><footer className="site-footer"><Brand small /><span>Small doodles. Big connections.</span><span>Made for play <Heart size={14} /></span></footer>
  </div>;
}
