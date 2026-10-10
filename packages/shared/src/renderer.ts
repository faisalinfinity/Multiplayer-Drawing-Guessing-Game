import { HEIGHT, WIDTH, type DrawingEvent, type DrawingOp, type Point } from './index.js';

type Stroke = Extract<DrawingOp, { type: 'stroke' }>;
type Action = { kind: 'stroke'; id: string; chunks: Stroke[] } | { kind: 'single'; op: Exclude<DrawingOp, Stroke | { type: 'undo' }> };

/** Integer rasterization keeps live canvases, flood fills and saved replays identical. */
export class RasterCanvas {
  readonly pixels: Uint8ClampedArray;
  private readonly words: Uint32Array;
  private actions: Action[] = [];
  private readonly colors = new Map<string, number>();
  private readonly brushes = new Map<number, Array<{ y: number; extent: number }>>();

  constructor(readonly width = WIDTH, readonly height = HEIGHT) {
    this.pixels = new Uint8ClampedArray(width * height * 4);
    this.words = new Uint32Array(this.pixels.buffer);
    this.words.fill(0xffffffff);
  }

  reset() {
    this.actions = [];
    this.words.fill(0xffffffff);
  }

  render(ops: readonly DrawingOp[]) {
    this.reset();
    for (const op of ops) this.apply(op);
    return this.pixels;
  }

  apply(op: DrawingOp) {
    if (op.type === 'undo') {
      this.actions.pop();
      this.rebuild();
      return;
    }
    if (op.type === 'stroke') {
      const previous = this.actions.at(-1);
      const action = previous?.kind === 'stroke' && previous.id === op.strokeId
        ? previous
        : { kind: 'stroke' as const, id: op.strokeId, chunks: [] };
      const from = action.chunks.at(-1)?.points.at(-1);
      if (action !== previous) this.actions.push(action);
      action.chunks.push(op);
      this.paintStroke(op, from);
      return;
    }
    this.actions.push({ kind: 'single', op });
    this.paintSingle(op);
  }

  private rebuild() {
    this.words.fill(0xffffffff);
    for (const action of this.actions) {
      if (action.kind === 'single') this.paintSingle(action.op);
      else {
        let previous: Point | undefined;
        for (const chunk of action.chunks) {
          this.paintStroke(chunk, previous);
          previous = chunk.points.at(-1);
        }
      }
    }
  }

  private color(hex: string) {
    const cached = this.colors.get(hex);
    if (cached !== undefined) return cached;
    const rgba = new Uint8Array([parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255]);
    const packed = new Uint32Array(rgba.buffer)[0]!;
    this.colors.set(hex, packed);
    return packed;
  }

  private paintSingle(op: Exclude<DrawingOp, Stroke | { type: 'undo' }>) {
    if (op.type === 'clear') this.words.fill(0xffffffff);
    else this.flood(op.point, this.color(op.color));
  }

  private paintStroke(op: Stroke, from?: Point) {
    const color = op.tool === 'eraser' ? 0xffffffff : this.color(op.color);
    for (const point of op.points) {
      if (from) this.line(from, point, op.size, color);
      else this.dot(point.x, point.y, op.size, color);
      from = point;
    }
  }

  private dot(cx: number, cy: number, size: number, color: number) {
    let spans = this.brushes.get(size);
    if (!spans) {
      spans = [];
      const radius = (size - 1) / 2;
      for (let y = -Math.floor(radius); y <= Math.floor(radius); y++) {
        spans.push({ y, extent: Math.floor(Math.sqrt(radius * radius - y * y)) });
      }
      this.brushes.set(size, spans);
    }
    for (const span of spans) {
      const y = cy + span.y;
      if (y < 0 || y >= this.height) continue;
      const start = Math.max(0, cx - span.extent);
      const end = Math.min(this.width - 1, cx + span.extent);
      if (end >= start) this.words.fill(color, y * this.width + start, y * this.width + end + 1);
    }
  }

  private line(from: Point, to: Point, size: number, color: number) {
    let x = from.x;
    let y = from.y;
    const dx = Math.abs(to.x - x);
    const dy = -Math.abs(to.y - y);
    const sx = x < to.x ? 1 : -1;
    const sy = y < to.y ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      this.dot(x, y, size, color);
      if (x === to.x && y === to.y) return;
      const doubled = error * 2;
      if (doubled >= dy) { error += dy; x += sx; }
      if (doubled <= dx) { error += dx; y += sy; }
    }
  }

  private flood(point: Point, replacement: number) {
    const start = point.y * this.width + point.x;
    const target = this.words[start];
    if (target === undefined || target === replacement) return;
    // Mark when enqueuing so every pixel is visited at most once, even in large regions.
    const queue = new Uint32Array(this.words.length);
    let read = 0;
    let write = 0;
    queue[write++] = start;
    this.words[start] = replacement;
    const enqueue = (index: number) => {
      if (this.words[index] === target) { this.words[index] = replacement; queue[write++] = index; }
    };
    while (read < write) {
      const current = queue[read++]!;
      const x = current % this.width;
      if (x > 0) enqueue(current - 1);
      if (x + 1 < this.width) enqueue(current + 1);
      if (current >= this.width) enqueue(current - this.width);
      if (current + this.width < this.words.length) enqueue(current + this.width);
    }
  }
}

/** Sort and deduplicate transport events before reconstructing a saved drawing. */
export function orderedDrawingEvents(events: readonly DrawingEvent[]): DrawingEvent[] {
  const commands = new Set<string>();
  return [...events].sort((a, b) => a.seq - b.seq).filter(event => {
    if (commands.has(event.commandId)) return false;
    commands.add(event.commandId);
    return true;
  });
}

export function renderDrawing(events: readonly DrawingEvent[], width = WIDTH, height = HEIGHT): RasterCanvas {
  const raster = new RasterCanvas(width, height);
  raster.render(orderedDrawingEvents(events).map(event => event.op));
  return raster;
}
