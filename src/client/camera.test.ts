import { describe, expect, it } from 'vitest';
import { config } from '../core/index.ts';
import { createCamera, parseView } from './camera.ts';

const W = config.world.widthU;
const CAT_Y = config.world.catLineY;

describe('camera: flat', () => {
  const c = createCamera('flat');
  it('is the identity', () => {
    expect(c.project(10, 20)).toEqual({ x: 10, y: 20, s: 1 });
    expect(c.project(500, -14)).toEqual({ x: 500, y: -14, s: 1 });
  });
});

describe('camera: tilt (2.5D)', () => {
  const c = createCamera('tilt');
  it('leaves the cat row untouched, so pointer x maps 1:1 at the cat', () => {
    for (const x of [0, 100, 270, 540]) expect(c.project(x, CAT_Y)).toEqual({ x, y: CAT_Y, s: 1 });
  });
  it('shrinks things ahead toward the centre line, monotonically', () => {
    let prev = c.project(0, CAT_Y);
    for (let y = CAT_Y - 40; y >= -200; y -= 40) {
      const p = c.project(0, y);
      expect(p.s).toBeLessThan(prev.s);
      expect(p.y).toBeLessThan(prev.y);
      expect(p.x).toBeGreaterThan(prev.x); // left edge leans in
      prev = p;
    }
    expect(c.project(W / 2, 0).x).toBeCloseTo(W / 2, 9);
  });
  it('keeps the whole lane top on screen, at a moderate scale', () => {
    const top = c.project(0, 0);
    expect(top.y).toBeGreaterThan(0);
    expect(top.y).toBeLessThan(140);
    expect(top.s).toBeGreaterThan(0.4);
    expect(top.s).toBeLessThan(0.7);
  });
  it('things behind the cat grow and drop below it', () => {
    const p = c.project(270, CAT_Y + 60);
    expect(p.s).toBeGreaterThan(1);
    expect(p.y).toBeGreaterThan(CAT_Y);
  });
});

describe('parseView', () => {
  it('URL wins, then storage, else flat; junk is ignored', () => {
    expect(parseView('?view=tilt', null)).toBe('tilt');
    expect(parseView('?view=flat', 'tilt')).toBe('flat');
    expect(parseView('', 'tilt')).toBe('tilt');
    expect(parseView('?view=nope', 'junk')).toBe('flat');
    expect(parseView('?seed=abcd', null)).toBe('flat');
  });
});
