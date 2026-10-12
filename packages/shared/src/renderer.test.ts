import { describe, expect, it } from 'vitest';
import { RasterCanvas, renderDrawing } from './renderer.js';
import type { DrawingEvent, DrawingOp, Point } from './index.js';

const stroke = (points: Point[], extra: Partial<Extract<DrawingOp, { type: 'stroke' }>> = {}): DrawingOp => ({ type: 'stroke', strokeId: 'a', index: 0, tool: 'pen', color: '#25243a', size: 3, points, end: true, ...extra });
const pixel = (raster: RasterCanvas, x: number, y: number) => [...raster.pixels.slice((y * raster.width + x) * 4, (y * raster.width + x) * 4 + 4)];

describe('deterministic drawing renderer', () => {
  it('connects streamed chunks exactly as a contiguous stroke', () => {
    const points = [{ x: 2, y: 2 }, { x: 12, y: 6 }, { x: 16, y: 15 }];
    const streamed = new RasterCanvas(20, 20);
    streamed.apply(stroke(points.slice(0, 1), { end: false }));
    streamed.apply(stroke(points.slice(1), { index: 1 }));
    const contiguous = new RasterCanvas(20, 20);
    contiguous.apply(stroke(points));
    expect(streamed.pixels).toEqual(contiguous.pixels);
  });

  it('fills only the enclosed region and erases to white', () => {
    const raster = new RasterCanvas(20, 20);
    raster.apply(stroke([{ x: 4, y: 4 }, { x: 15, y: 4 }, { x: 15, y: 15 }, { x: 4, y: 15 }, { x: 4, y: 4 }], { size: 1 }));
    raster.apply({ type: 'fill', point: { x: 8, y: 8 }, color: '#ef6461' });
    expect(pixel(raster, 8, 8)).toEqual([239, 100, 97, 255]);
    expect(pixel(raster, 0, 0)).toEqual([255, 255, 255, 255]);
    raster.apply(stroke([{ x: 8, y: 8 }], { strokeId: 'eraser', tool: 'eraser' }));
    expect(pixel(raster, 8, 8)).toEqual([255, 255, 255, 255]);
  });

  it('undoes a complete multi-chunk stroke, then fill and clear independently', () => {
    const raster = new RasterCanvas(20, 20);
    raster.apply({ type: 'fill', point: { x: 0, y: 0 }, color: '#64c4d8' });
    const filled = raster.pixels.slice();
    raster.apply(stroke([{ x: 2, y: 2 }], { end: false }));
    raster.apply(stroke([{ x: 16, y: 16 }], { index: 1 }));
    raster.apply({ type: 'undo' });
    expect(raster.pixels).toEqual(filled);
    raster.apply({ type: 'clear' });
    expect(pixel(raster, 8, 8)).toEqual([255, 255, 255, 255]);
    raster.apply({ type: 'undo' });
    expect(raster.pixels).toEqual(filled);
    raster.apply({ type: 'undo' });
    expect(pixel(raster, 8, 8)).toEqual([255, 255, 255, 255]);
    raster.apply({ type: 'undo' });
    expect(pixel(raster, 8, 8)).toEqual([255, 255, 255, 255]);
  });

  it('reconstructs out-of-order duplicated transport events identically to live state', () => {
    const ops: DrawingOp[] = [stroke([{ x: 0, y: 0 }, { x: 19, y: 19 }]), { type: 'fill', point: { x: 0, y: 19 }, color: '#62b895' }, { type: 'clear' }, { type: 'undo' }];
    const events: DrawingEvent[] = ops.map((op, seq) => ({ op, seq, turnId: 'turn', commandId: `cmd-${seq}`, at: seq * 33 }));
    const live = new RasterCanvas(20, 20);
    for (const op of ops) live.apply(op);
    expect(renderDrawing([events[3]!, events[1]!, events[0]!, events[1]!, events[2]!], 20, 20).pixels).toEqual(live.pixels);
  });

  it('bounds corner brushes and makes repeated same-color fills a no-op', () => {
    const raster = new RasterCanvas(20, 20);
    raster.apply(stroke([{ x: 0, y: 0 }], { size: 40 }));
    expect(pixel(raster, 0, 0)).toEqual([37, 36, 58, 255]);
    raster.apply({ type: 'fill', point: { x: 19, y: 19 }, color: '#ffffff' });
    expect(pixel(raster, 19, 19)).toEqual([255, 255, 255, 255]);
    expect(raster.pixels.length).toBe(1600);
  });
});
