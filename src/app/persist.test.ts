import { describe, expect, it } from 'vitest';
import type { ParamSpec } from '../core/types';
import { loadJSON, persistableParams, sanitizeParams, sanitizeValue, saveJSON, type KeyValueStore } from './persist';

const SPECS: ParamSpec[] = [
  { kind: 'number', key: 'n', label: { tr: 'n', en: 'n' }, min: 0, max: 1, step: 0.1, default: 0.5 },
  { kind: 'boolean', key: 'b', label: { tr: 'b', en: 'b' }, default: true },
  {
    kind: 'select',
    key: 's',
    label: { tr: 's', en: 's' },
    default: 'a',
    options: [
      { value: 'a', label: { tr: 'a', en: 'a' } },
      { value: 'b', label: { tr: 'b', en: 'b' } },
    ],
  },
  { kind: 'text', key: 't', label: { tr: 't', en: 't' }, default: '' },
  { kind: 'text', key: 'key', label: { tr: 'k', en: 'k' }, default: '', secret: true },
];

describe('sanitizeParams', () => {
  it('keeps valid stored values, clamps numbers and falls back to defaults', () => {
    const out = sanitizeParams(SPECS, { n: 7, b: 'yes', s: 'b', t: 'hello', extra: 1 });
    expect(out).toEqual({ n: 1, b: true, s: 'b', t: 'hello', key: '' });
  });

  it('handles garbage', () => {
    expect(sanitizeParams(SPECS, null)).toEqual({ n: 0.5, b: true, s: 'a', t: '', key: '' });
    expect(sanitizeParams(SPECS, 'nope')).toEqual({ n: 0.5, b: true, s: 'a', t: '', key: '' });
    expect(sanitizeValue(SPECS[0], NaN)).toBeUndefined();
    expect(sanitizeValue(SPECS[2], 'zzz')).toBeUndefined();
  });
});

describe('persistableParams', () => {
  it('drops secret text params', () => {
    expect(persistableParams(SPECS, { n: 0.2, key: 'tsk_123', t: 'x' })).toEqual({ n: 0.2, t: 'x' });
  });
});

describe('loadJSON / saveJSON', () => {
  it('round-trips under a prefix and tolerates broken or throwing storage', () => {
    const map = new Map<string, string>();
    const store: KeyValueStore = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
    saveJSON(store, 'x', { a: 1 });
    expect(map.has('3dmarker:x')).toBe(true);
    expect(loadJSON(store, 'x')).toEqual({ a: 1 });
    map.set('3dmarker:bad', '{not json');
    expect(loadJSON(store, 'bad')).toBeUndefined();
    expect(loadJSON(null, 'x')).toBeUndefined();
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(() => saveJSON(throwing, 'x', 1)).not.toThrow();
    expect(loadJSON(throwing, 'x')).toBeUndefined();
  });
});
