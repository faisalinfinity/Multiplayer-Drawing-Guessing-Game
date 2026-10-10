'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Eraser, PaintBucket, Pencil, Trash2, Undo2 } from 'lucide-react';
import { HEIGHT, PALETTE, WIDTH, type Ack, type DrawingEvent, type DrawingOp, type Point } from '@doodle/shared';
import { orderedDrawingEvents, RasterCanvas } from '@doodle/shared/renderer';

type Tool = 'pen' | 'eraser' | 'fill';
type StrokeOp = Extract<DrawingOp, { type: 'stroke' }>;
type ActiveStroke = { id: string; pointerId: number; index: number; tool: 'pen' | 'eraser'; color: string; size: number; last: Point; draft: { id: string; op: StrokeOp } | null };

export interface DrawingCanvasProps {
  events: DrawingEvent[];
  turnId: string | null;
  canDraw: boolean;
  onDraw: (op: DrawingOp, commandId: string) => Promise<Ack>;
  disabled?: boolean;
}

const colorNames = ['Ink', 'White', 'Gray', 'Coral', 'Orange', 'Yellow', 'Mint', 'Sky', 'Blue', 'Purple', 'Pink', 'Brown'];

export function DrawingCanvas({ events, turnId, canDraw, onDraw, disabled = false }: DrawingCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rasterRef = useRef<RasterCanvas | null>(null);
  const acceptedRef = useRef<DrawingEvent[]>([]);
  const pendingRef = useRef(new Map<string, DrawingOp>());
  const appliedRef = useRef<string[]>([]);
  const turnRef = useRef<string | null>(null);
  const activeRef = useRef<ActiveStroke | null>(null);
  const frameRef = useRef<number | null>(null);
  const sendRef = useRef(onDraw);
  const enabledRef = useRef(false);
  const [tool, setTool] = useState<Tool>('pen');
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [size, setSize] = useState(8);
  const [error, setError] = useState('');
  const enabled = canDraw && !disabled && Boolean(turnId);

  useEffect(() => { sendRef.current = onDraw; }, [onDraw]);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const raster = useCallback(() => {
    rasterRef.current ??= new RasterCanvas();
    return rasterRef.current;
  }, []);

  const paint = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const context = canvasRef.current?.getContext('2d');
      if (!context) return;
      const image = context.createImageData(WIDTH, HEIGHT);
      image.data.set(raster().pixels);
      context.putImageData(image, 0, 0);
    });
  }, [raster]);

  const reconcile = useCallback((force = false) => {
    const confirmed = orderedDrawingEvents(acceptedRef.current);
    for (const event of confirmed) pendingRef.current.delete(event.commandId);
    const operations = [
      ...confirmed.map(event => ({ id: event.commandId, op: event.op })),
      ...[...pendingRef.current].map(([id, op]) => ({ id, op })),
    ];
    const keys = operations.map(entry => entry.id);
    const previous = appliedRef.current;
    const appendOnly = !force && previous.length <= keys.length && previous.every((id, index) => keys[index] === id);
    if (!appendOnly) raster().reset();
    for (const entry of operations.slice(appendOnly ? previous.length : 0)) raster().apply(entry.op);
    appliedRef.current = keys;
    paint();
  }, [paint, raster]);

  const transmit = useCallback((op: DrawingOp, id: string) => {
    const sendingTurn = turnRef.current;
    void sendRef.current(op, id).then(ack => {
      if (sendingTurn !== turnRef.current || ack.ok) return;
      pendingRef.current.delete(id);
      if (activeRef.current?.draft) pendingRef.current.delete(activeRef.current.draft.id);
      activeRef.current = null;
      setError(ack.error ?? 'That drawing update was not accepted. Try again.');
      reconcile(true);
    }).catch(() => {
      if (sendingTurn !== turnRef.current) return;
      pendingRef.current.delete(id);
      if (activeRef.current?.draft) pendingRef.current.delete(activeRef.current.draft.id);
      activeRef.current = null;
      setError('Drawing paused while the connection recovers.');
      reconcile(true);
    });
  }, [reconcile]);

  const flush = useCallback((end = false) => {
    const active = activeRef.current;
    if (!active || !enabledRef.current) return;
    if (!active.draft && end) {
      const id = crypto.randomUUID();
      const op: StrokeOp = { type: 'stroke', strokeId: active.id, index: active.index++, tool: active.tool, color: active.color, size: active.size, points: [active.last], end: true };
      pendingRef.current.set(id, op);
      appliedRef.current.push(id);
      raster().apply(op);
      active.draft = { id, op };
    }
    if (!active.draft) return;
    active.draft.op.end = end;
    const draft = active.draft;
    active.draft = null;
    transmit(draft.op, draft.id);
  }, [raster, transmit]);

  const finish = useCallback(() => {
    if (!activeRef.current) return;
    flush(true);
    activeRef.current = null;
  }, [flush]);

  const submit = useCallback((op: DrawingOp) => {
    if (!enabledRef.current || pendingRef.current.size >= 128) return;
    finish();
    setError('');
    const id = crypto.randomUUID();
    pendingRef.current.set(id, op);
    reconcile();
    transmit(op, id);
  }, [finish, reconcile, transmit]);

  useEffect(() => {
    if (turnRef.current !== turnId) {
      turnRef.current = turnId;
      activeRef.current = null;
      pendingRef.current.clear();
      appliedRef.current = [];
      raster().reset();
    }
    acceptedRef.current = events.filter(event => event.turnId === turnId);
    reconcile();
  }, [events, turnId, raster, reconcile]);

  useEffect(() => {
    if (!enabled && activeRef.current) {
      const draft = activeRef.current.draft;
      if (draft) pendingRef.current.delete(draft.id);
      activeRef.current = null;
      reconcile(true);
    }
  }, [enabled, reconcile]);

  useEffect(() => {
    const interval = window.setInterval(() => flush(), 33);
    return () => { window.clearInterval(interval); if (frameRef.current !== null) cancelAnimationFrame(frameRef.current); };
  }, [flush]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (!enabledRef.current || target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault(); submit({ type: 'undo' }); return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const next = ({ b: 'pen', e: 'eraser', f: 'fill' } as const)[event.key.toLowerCase() as 'b' | 'e' | 'f'];
      if (next) { event.preventDefault(); finish(); setTool(next); }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [submit, finish]);

  const pointFrom = (event: Pick<PointerEvent, 'clientX' | 'clientY'>): Point => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(WIDTH - 1, Math.round((event.clientX - rect.left) * WIDTH / rect.width))), y: Math.max(0, Math.min(HEIGHT - 1, Math.round((event.clientY - rect.top) * HEIGHT / rect.height))) };
  };

  const addPoint = (point: Point) => {
    const active = activeRef.current;
    if (!active) return;
    if (pendingRef.current.size >= 128 && !active.draft) {
      activeRef.current = null;
      setError('Drawing is catching up. Please wait a moment.');
      return;
    }
    if (!active.draft) {
      const id = crypto.randomUUID();
      const op: StrokeOp = { type: 'stroke', strokeId: active.id, index: active.index++, tool: active.tool, color: active.color, size: active.size, points: [], end: false };
      active.draft = { id, op };
      pendingRef.current.set(id, op);
      appliedRef.current.push(id);
    }
    const draft = active.draft.op;
    draft.points.push(point);
    active.last = point;
    // Apply only the new point; replay uses the corresponding complete point batch.
    raster().apply({ ...draft, points: [point] });
    paint();
    if (draft.points.length === 64) flush();
  };

  const pointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!enabled || activeRef.current || event.button !== 0) return;
    event.preventDefault();
    setError('');
    const point = pointFrom(event.nativeEvent);
    if (tool === 'fill') { submit({ type: 'fill', point, color }); return; }
    event.currentTarget.setPointerCapture(event.pointerId);
    activeRef.current = { id: crypto.randomUUID(), pointerId: event.pointerId, index: 0, tool, color, size, last: point, draft: null };
    addPoint(point);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const active = activeRef.current;
    if (!enabled || !active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    const coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
    for (const sample of coalesced.length ? coalesced : [event.nativeEvent]) {
      const point = pointFrom(sample);
      if (point.x !== active.last.x || point.y !== active.last.y) addPoint(point);
    }
  };

  return <section className="canvas-shell" aria-label="Drawing board">
    <div className="canvas-stage" style={{ aspectRatio: '4 / 3', background: '#fff', position: 'relative', overflow: 'hidden' }}>
      <canvas ref={canvasRef} data-testid="drawing-canvas" width={WIDTH} height={HEIGHT} aria-label={enabled ? 'Drawing canvas. Use your pointer to draw.' : 'Live drawing canvas'} role="img" tabIndex={enabled ? 0 : -1}
        style={{ display: 'block', width: '100%', height: '100%', touchAction: enabled ? 'none' : 'auto', cursor: enabled ? 'crosshair' : 'default' }}
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} />
    </div>
    {canDraw && <div className="drawing-toolbar" aria-label="Drawing tools" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '12px 14px' }}>
      <div className="tool-group" style={{ display: 'flex', gap: 4 }}>
        {([{ id: 'pen', label: 'Pen', Icon: Pencil, key: 'B' }, { id: 'eraser', label: 'Eraser', Icon: Eraser, key: 'E' }, { id: 'fill', label: 'Fill', Icon: PaintBucket, key: 'F' }] as const).map(({ id, label, Icon, key }) => <button key={id} type="button" className={`tool-button ${tool === id ? 'active' : ''}`} disabled={!enabled} aria-label={label} aria-pressed={tool === id} title={`${label} (${key})`} onClick={() => { finish(); setTool(id); }}><Icon size={18} aria-hidden="true" /></button>)}
      </div>
      <div className="color-palette" role="group" aria-label="Brush colors" style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {PALETTE.map((swatch, index) => <button key={swatch} type="button" className={`color-swatch ${color === swatch ? 'active' : ''}`} style={{ background: swatch, width: 23, height: 23, borderRadius: '50%', border: color === swatch ? '3px solid #25243a' : '1px solid #25243a30', boxShadow: color === swatch ? 'inset 0 0 0 2px white' : 'none' }} aria-label={`${colorNames[index]} color`} aria-pressed={color === swatch} title={colorNames[index]} disabled={!enabled} onClick={() => { finish(); setColor(swatch); if (tool === 'eraser') setTool('pen'); }} />)}
      </div>
      <label className="brush-size" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>Size <input aria-label="Brush size" type="range" min="1" max="40" value={size} style={{ width: 68 }} disabled={!enabled} onChange={event => { finish(); setSize(Number(event.target.value)); }} /><span style={{ minWidth: 20 }}>{size}</span></label>
      <div className="tool-group" style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
        <button type="button" className="tool-button" disabled={!enabled} aria-label="Undo" title="Undo (Ctrl/⌘ Z)" onClick={() => submit({ type: 'undo' })}><Undo2 size={18} aria-hidden="true" /></button>
        <button type="button" className="tool-button" disabled={!enabled} aria-label="Clear canvas" title="Clear canvas" onClick={() => submit({ type: 'clear' })}><Trash2 size={18} aria-hidden="true" /></button>
      </div>
    </div>}
    {error && <p className="canvas-error" role="alert" style={{ padding: '0 14px 10px', color: '#a23838', fontSize: 13 }}>{error}</p>}
  </section>;
}
