'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Film, LoaderCircle, Pause, Play, RotateCcw, Trophy } from 'lucide-react';
import { HEIGHT, WIDTH, type Ack, type Command, type PublicRoom, type ReplayDrawing, type ReplayIndex, type ReplaySummary } from '@doodle/shared';
import { RasterCanvas, renderDrawing } from '@doodle/shared/renderer';
import { Avatar } from './brand';
import { Button } from './ui/button';
import { api } from '@/lib/utils';

function turnUrl(roomId: string, gameId: string, turnId: string) { return `/api/rooms/${encodeURIComponent(roomId)}/games/${encodeURIComponent(gameId)}/turns/${encodeURIComponent(turnId)}`; }

function paint(canvas: HTMLCanvasElement, raster: RasterCanvas) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const image = context.createImageData(WIDTH, HEIGHT); image.data.set(raster.pixels); context.putImageData(image, 0, 0);
}

export function ReplayGallery({ room, playerId, disabled, command }: { room: PublicRoom; playerId: string; disabled: boolean; command: (value: Command) => Promise<Ack> }) {
  const [index, setIndex] = useState<ReplayIndex | null>(null);
  const [selected, setSelected] = useState(0);
  const [drawing, setDrawing] = useState<ReplayDrawing | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const gameId = room.gameId || room.completedGames.at(-1);
  const players = [...(index?.players || room.players)].sort((a, b) => b.score - a.score);
  const winner = players[0];
  useEffect(() => {
    if (!gameId) return;
    let active = true;
    void api<ReplayIndex>(`/api/rooms/${encodeURIComponent(room.id)}/games/${encodeURIComponent(gameId)}`).then(value => { if (active) { setIndex(value); setError(''); } }).catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [room.id, gameId, retry]);
  useEffect(() => {
    const chosen = index?.drawings[selected];
    if (!chosen || !gameId) return;
    let active = true;
    setDrawing(null);
    void api<ReplayDrawing>(turnUrl(room.id, gameId, chosen.turnId)).then(value => { if (active) { setDrawing(value); setError(''); } }).catch((err: Error) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [index, selected, room.id, gameId, retry]);
  async function lobby() { setBusy(true); const result = await command({ type: 'lobby' }); if (!result.ok) setError(result.error || 'Please try again.'); setBusy(false); }
  return <main className="room-main results-main"><section className="results-heading"><div className="trophy-stamp"><Trophy size={33} /></div><span className="eyebrow">GOOD FRIENDS. QUESTIONABLE ART. GREAT GAME.</span><h1>A round of applause.</h1><p>{winner ? <><strong>{winner.name}</strong> takes the crown. The masterpieces belong to everyone.</> : 'The masterpieces belong to everyone.'}</p><div className="podium">{players.slice(0, 3).map((player, rank) => <div className={`podium-player podium-${rank}`} key={player.id}><div className="podium-avatar"><Avatar index={player.avatar} name={player.name} size={rank === 0 ? 65 : 53} /><span>{rank === 0 ? <Trophy size={12} /> : rank + 1}</span></div><strong>{player.name}{player.id === playerId && <small>you</small>}</strong><span>{player.score.toLocaleString()} points</span></div>)}</div>{players.length > 3 && <div className="remaining-scores">{players.slice(3).map((player, rank) => <span key={player.id}>{rank + 4}. {player.name} <strong>{player.score}</strong></span>)}</div>}<div className="results-actions">{room.hostId === playerId ? <Button onClick={() => void lobby()} disabled={disabled || busy}><RotateCcw size={16} /> One more round?</Button> : <span className="muted">The host can bring everyone back for another game.</span>}<a href="#the-gallery" className="text-link">Visit your gallery <ChevronRight size={15} /></a></div></section>
    <section className="replay-section" id="the-gallery"><div className="gallery-heading"><div><span className="eyebrow">ART IS BETTER THE SECOND TIME</span><h2>Your very own little gallery.</h2></div><span className="gallery-count"><Film size={15} />{index?.drawings.length || 0} masterpieces</span></div><p className="gallery-description">Every line, every wild idea. Watch your drawings come to life again.</p>{error && <div className="inline-error" role="alert">{error} <button className="text-link" onClick={() => setRetry(retry + 1)}>Try again</button></div>}{!index && !error && <div className="gallery-loading"><LoaderCircle className="spin" /> Hanging your masterpieces…</div>}{index && index.drawings.length > 0 && <div className="replay-layout"><div className="replay-feature">{drawing ? <ReplayPlayer key={drawing.turnId} drawing={drawing} /> : <div className="replay-loading"><LoaderCircle className="spin" /><span>Unrolling the canvas…</span></div>}<div className="replay-nav"><Button size="small" variant="ghost" disabled={selected === 0} onClick={() => setSelected(selected - 1)}><ChevronLeft size={16} /> Previous</Button><span>{selected + 1} / {index.drawings.length}</span><Button size="small" variant="ghost" disabled={selected === index.drawings.length - 1} onClick={() => setSelected(selected + 1)}>Next <ChevronRight size={16} /></Button></div></div><div className="gallery-grid" aria-label="All drawings">{index.drawings.map((summary, position) => <ReplayThumbnail key={summary.turnId} summary={summary} url={turnUrl(room.id, gameId!, summary.turnId)} selected={position === selected} onSelect={() => setSelected(position)} />)}</div></div>}{index && index.drawings.length === 0 && <p className="gallery-loading">No drawings were completed in this game. Start another and make your mark.</p>}<p className="replay-retention"><Check size={12} /> Saved for seven days. Download your favorites to keep them.</p></section></main>;
}

function ReplayThumbnail({ summary, url, selected, onSelect }: { summary: ReplaySummary; url: string; selected: boolean; onSelect: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '150px' });
    if (buttonRef.current) observer.observe(buttonRef.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void api<ReplayDrawing>(url).then(value => {
      if (!active || !canvasRef.current) return;
      const source = document.createElement('canvas'); source.width = WIDTH; source.height = HEIGHT;
      paint(source, renderDrawing(value.events));
      canvasRef.current.getContext('2d')?.drawImage(source, 0, 0, 240, 180);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [url, visible]);
  return <button ref={buttonRef} className={`gallery-thumbnail ${selected ? 'selected' : ''}`} onClick={onSelect} aria-pressed={selected} aria-label={`Replay ${summary.word} by ${summary.drawerName}`}><div className="thumbnail-image"><canvas width={240} height={180} ref={canvasRef} aria-hidden="true" />{failed && <span>Preview unavailable</span>}<span className="thumbnail-play"><Play size={15} fill="currentColor" /></span></div><div className="thumbnail-label"><strong>{summary.word}</strong><span>by {summary.drawerName}</span></div></button>;
}

function ReplayPlayer({ drawing }: { drawing: ReplayDrawing }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rasterRef = useRef<RasterCanvas | null>(null);
  const cursorRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [elapsed, setElapsed] = useState(0);
  const duration = Math.max(1, drawing.endedAt - drawing.startedAt, (drawing.events.at(-1)?.at || drawing.startedAt) - drawing.startedAt);
  useEffect(() => {
    const raster = rasterRef.current ??= new RasterCanvas();
    const count = drawing.events.filter(event => event.at - drawing.startedAt <= elapsed).length;
    if (count < cursorRef.current) { raster.reset(); cursorRef.current = 0; }
    for (const event of drawing.events.slice(cursorRef.current, count)) raster.apply(event.op);
    cursorRef.current = count;
    if (canvasRef.current) paint(canvasRef.current, raster);
  }, [drawing, elapsed]);
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now(); const delta = (now - last) * speed; last = now;
      setElapsed(value => Math.min(duration, value + delta));
    }, 33);
    return () => clearInterval(interval);
  }, [playing, speed, duration]);
  useEffect(() => { if (elapsed >= duration) setPlaying(false); }, [elapsed, duration]);
  function toggle() { if (!playing && elapsed >= duration) setElapsed(0); setPlaying(!playing); }
  function download() {
    const canvas = document.createElement('canvas'); canvas.width = WIDTH; canvas.height = HEIGHT; paint(canvas, renderDrawing(drawing.events));
    canvas.toBlob(blob => { if (!blob) return; const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `doodleroom-${drawing.word.replace(/[^\p{L}\p{N} -]/gu, '')}.png`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); });
  }
  const time = (value: number) => `${Math.floor(value / 60000)}:${String(Math.floor((value % 60000) / 1000)).padStart(2, '0')}`;
  return <div className="replay-player"><div className="replay-title"><div><span>THE MASTERPIECE</span><h3>{drawing.word}</h3></div><span>by <strong>{drawing.drawerName}</strong></span><Button variant="ghost" size="icon" onClick={download} aria-label="Download finished drawing"><Download size={17} /></Button></div><div className="replay-canvas"><canvas data-testid="replay-canvas" ref={canvasRef} width={WIDTH} height={HEIGHT} aria-label={`Replay of ${drawing.word}`} />{!playing && elapsed === 0 && <button onClick={toggle} className="replay-start" aria-label="Play drawing replay"><Play size={29} fill="currentColor" /><span>Watch it come to life</span></button>}</div><div className="replay-controls"><Button size="icon" variant="ghost" onClick={toggle} aria-label={playing ? 'Pause replay' : 'Play replay'}>{playing ? <Pause size={19} /> : <Play size={19} fill="currentColor" />}</Button><input type="range" min={0} max={duration} step={1} value={elapsed} onChange={event => setElapsed(Number(event.target.value))} aria-label="Replay position" data-testid="replay-seek" aria-valuetext={`${time(elapsed)} of ${time(duration)}`} /><span className="replay-time">{time(elapsed)} / {time(duration)}</span><select aria-label="Playback speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}>{[0.5, 1, 2, 4].map(value => <option key={value} value={value}>{value}×</option>)}</select></div></div>;
}
