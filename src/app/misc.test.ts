import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, DataTexture, Group, Mesh, MeshStandardMaterial, RGBAFormat } from 'three';
import { DRIVERS } from '../drivers';
import { LocalizedError } from '../drivers/heuristic/inflate';
import { ImageLoadError, NOT_AN_IMAGE } from '../core/image/load';
import { baseName, errorToText, formatSeconds, modelFileName } from './format';
import { throttleLatest, yieldToPaint } from './throttle';
import { coveragePercent, maskOverlay } from './overlay';
import { disposeObject } from './dispose';
import { createClayMatcap } from './viewer';
import { bestFor, groupDrivers, outputKind, suggestedMeshMode } from './driverMeta';
import { SAMPLES, mulberry32 } from './samples';

describe('format', () => {
  it('builds download names from the upload name and driver id', () => {
    expect(modelFileName('cat.photo.png', 'depth-anything-v2-small', 'glb')).toBe('cat.photo-depth-anything-v2-small.glb');
    expect(modelFileName('a/b:c.PNG', 'x', 'stl')).toBe('a_b_c-x.stl');
    expect(modelFileName('', 'x', 'obj')).toBe('3dmarker-x.obj');
    // Rigged models get a suffix.
    expect(modelFileName('cat.png', 'silhouette-inflate', 'glb', 'rigged')).toBe('cat-silhouette-inflate-rigged.glb');
    expect(baseName('  spaced .png')).toBe('spaced');
  });

  it('keeps both languages of localized errors', () => {
    expect(errorToText(new LocalizedError({ tr: 'Türkçe', en: 'English' }))).toEqual({ tr: 'Türkçe', en: 'English' });
    expect(errorToText(new ImageLoadError(NOT_AN_IMAGE))).toEqual(NOT_AN_IMAGE);
    expect(errorToText(new Error('plain'))).toEqual({ tr: 'plain', en: 'plain' });
    expect(errorToText('str')).toEqual({ tr: 'str', en: 'str' });
    expect(errorToText(undefined).en).toBe('Unknown error');
  });

  it('formats durations', () => {
    expect(formatSeconds(1234)).toBe('1.2');
    expect(formatSeconds(65_400)).toBe('65');
  });
});

describe('throttleLatest', () => {
  it('emits only the latest value per frame and stops after cancel', () => {
    const queue: (() => void)[] = [];
    const schedule = (fn: () => void) => {
      queue.push(fn);
      return () => queue.splice(queue.indexOf(fn), 1);
    };
    const emit = vi.fn();
    const th = throttleLatest<number>(emit, schedule);
    th.push(1);
    th.push(2);
    th.push(3);
    expect(queue).toHaveLength(1);
    queue.shift()!();
    expect(emit).toHaveBeenCalledExactlyOnceWith(3);
    th.push(4);
    th.cancel();
    expect(queue).toHaveLength(0);
    th.push(5);
    expect(queue).toHaveLength(0);
    expect(emit).toHaveBeenCalledOnce();
  });
});

describe('yieldToPaint', () => {
  it('falls back to a macrotask without requestAnimationFrame (Node)', async () => {
    expect(typeof requestAnimationFrame).toBe('undefined');
    let done = false;
    const p = yieldToPaint().then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    await p;
    expect(done).toBe(true);
  });

  it('waits two frames and then a task, with a timer if frames stop', async () => {
    vi.useFakeTimers();
    try {
      const frames: (() => void)[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: () => void) => frames.push(cb));
      let done = false;
      void yieldToPaint(250).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      frames.shift()!(); // frame N (progress emitted, React commits after it)
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(false);
      frames.shift()!(); // frame N+1 paints the label
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(done).toBe(true);

      // rAF never fires (tab hidden mid-wait): the safety timer resolves.
      done = false;
      void yieldToPaint(250).then(() => (done = true));
      await vi.advanceTimersByTimeAsync(249);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

describe('overlay', () => {
  it('tints background pixels only', () => {
    const mask = { width: 2, height: 1, data: new Uint8Array([1, 0]) };
    const o = maskOverlay(mask, [1, 2, 3, 4]);
    expect(Array.from(o.data)).toEqual([0, 0, 0, 0, 1, 2, 3, 4]);
    expect(coveragePercent(mask)).toBe(50);
    expect(coveragePercent({ width: 1000, height: 1, data: new Uint8Array(1000).fill(0).fill(1, 0, 3) })).toBe(0.3);
  });
});

describe('disposeObject', () => {
  it('disposes every geometry, material and texture once', () => {
    const tex = new DataTexture(new Uint8Array(4), 1, 1, RGBAFormat);
    const geo = new BoxGeometry();
    const mat = new MeshStandardMaterial({ map: tex, normalMap: tex });
    const root = new Group();
    root.add(new Mesh(geo, mat), new Mesh(geo, [mat, new MeshStandardMaterial()]));
    const spies = [vi.fn(), vi.fn(), vi.fn()];
    geo.addEventListener('dispose', spies[0]);
    mat.addEventListener('dispose', spies[1]);
    tex.addEventListener('dispose', spies[2]);
    expect(disposeObject(root)).toEqual({ geometries: 1, materials: 2, textures: 1 });
    for (const s of spies) expect(s).toHaveBeenCalledOnce();
  });
});

describe('createClayMatcap', () => {
  it('is a lit sphere: brighter towards the light (top-left) than the opposite side', () => {
    const tex = createClayMatcap(32);
    const d = tex.image.data as Uint8Array;
    const px = (i: number, j: number) => d[(j * 32 + i) * 4];
    expect(tex.colorSpace).toBe('srgb');
    expect(px(10, 22)).toBeGreaterThan(px(22, 10)); // row 0 = bottom, so j = 22 is the upper half
    expect(d[3]).toBe(255);
  });
});

describe('driverMeta', () => {
  it('mesh mode suggestions', () => {
    const byId = (id: string) => DRIVERS.find((d) => d.id === id)!;
    expect(suggestedMeshMode(byId('silhouette-inflate'))).toBe('double');
    expect(suggestedMeshMode(byId('depth-anything-v2-small'))).toBe('relief');
    expect(suggestedMeshMode(byId('luminance-heightmap'))).toBeNull();
  });

  it('groups drivers by category in select order and describes each', () => {
    const groups = groupDrivers(DRIVERS);
    expect(groups.map((g) => g.category)).toEqual(['ml', 'heuristic', 'multiview', 'cloud']);
    expect(groups.flatMap((g) => g.drivers)).toHaveLength(DRIVERS.length);
    for (const d of DRIVERS) {
      expect(bestFor(d).en).not.toBe('');
      expect(outputKind(d).tr).not.toBe('');
    }
    const byId = (id: string) => DRIVERS.find((d) => d.id === id)!;
    expect(outputKind(byId('multiview-fusion')).en).toMatch(/vertex colours/);
    expect(outputKind(byId('tripo3d-multiview')).en).toMatch(/GLB/);
    // Every built-in driver has its own "best for" line (not the category fallback).
    for (const id of ['multiview-fusion', 'tripo3d-multiview', 'ai-provider-3d']) expect(bestFor(byId(id)).en).not.toMatch(/^(Full 3D objects|Characters and objects with several views)$/);
  });
});

describe('samples', () => {
  it('have unique ids and recommend registered drivers', () => {
    expect(new Set(SAMPLES.map((s) => s.id)).size).toBe(SAMPLES.length);
    for (const s of SAMPLES) expect(DRIVERS.some((d) => d.id === s.driverId), s.driverId).toBe(true);
  });

  it('mulberry32 is deterministic and in [0, 1)', () => {
    const a = mulberry32(7), b = mulberry32(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('draw functions only use the Canvas 2D API (smoke test with a recording context)', () => {
    for (const s of SAMPLES) {
      const calls: string[] = [];
      const gradient = { addColorStop: () => {} };
      const ctx = new Proxy({} as Record<string, unknown>, {
        get(target, prop: string) {
          if (prop in target) return target[prop];
          if (prop === 'getImageData') return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) });
          if (prop.startsWith('create')) return () => gradient;
          return (...args: unknown[]) => {
            calls.push(prop);
            for (const a of args) if (typeof a === 'number' && !Number.isFinite(a)) throw new Error(`${prop}: non-finite arg`);
          };
        },
        set(target, prop: string, value) {
          target[prop] = value;
          return true;
        },
      });
      s.draw(ctx as unknown as CanvasRenderingContext2D, 96, 64);
      expect(calls.length, s.id).toBeGreaterThan(10);
      for (const [view, draw] of Object.entries(s.views ?? {})) {
        calls.length = 0;
        draw(ctx as unknown as CanvasRenderingContext2D, 96, 64);
        expect(calls.length, `${s.id}/${view}`).toBeGreaterThan(10);
      }
    }
  });

  it('the T-pose mannequin comes with back / left / right views for multi-view fusion', () => {
    const tpose = SAMPLES.find((s) => s.id === 'tpose')!;
    expect(tpose.driverId).toBe('multiview-fusion');
    expect(Object.keys(tpose.views ?? {}).sort()).toEqual(['back', 'left', 'right']);
  });
});
