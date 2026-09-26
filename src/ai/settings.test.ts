import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KeyValueStore } from '../app/persist';
import type { AiSettings } from './types';
import {
  AI_KEYS_KEY,
  AI_SETTINGS_KEY,
  createProviderConfig,
  currentAiSettings,
  DEFAULT_AI_SETTINGS,
  fetchServerInfo,
  fetchServerProviders,
  loadAiSettings,
  mergeServerProviders,
  normalizeDefaults,
  providerUsable,
  resolveProvider,
  saveAiSettings,
  setCurrentAiSettings,
  usableProviders,
} from './settings';
import { fakeNet, json } from './testing';

afterEach(() => vi.unstubAllGlobals());

class MemStore implements KeyValueStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

const keysIn = (s: MemStore) => s.map.get(`3dmarker:${AI_KEYS_KEY}`);

describe('createProviderConfig', () => {
  it('fills defaults from the kind', () => {
    const c = createProviderConfig('openai');
    expect(c.kind).toBe('openai');
    expect(c.label).toBe('OpenAI');
    expect(c.enabled).toBe(true);
    expect(c.apiKey).toBe('');
    expect(c.models).toEqual({ 'image-edit': 'gpt-image-1.5', 'background-removal': 'gpt-image-1.5' });
    expect(c.values).toEqual({ size: 'match', quality: 'auto', inputFidelity: 'high' });
    expect(c.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createProviderConfig('openai').id).not.toBe(c.id);
  });

  it('sanitises init values', () => {
    const c = createProviderConfig('openai', { values: { quality: 'ultra', size: '1024x1024' }, models: { 'image-edit': ' gpt-image-2 ' }, label: '  Mine  ' });
    expect(c.values.quality).toBe('auto');
    expect(c.values.size).toBe('1024x1024');
    expect(c.models['image-edit']).toBe('gpt-image-2');
    expect(c.label).toBe('Mine');
  });
});

describe('save / load', () => {
  const settings = (): AiSettings => {
    const a = createProviderConfig('openai', { id: 'a', apiKey: 'sk-a', label: 'Work' });
    const b = createProviderConfig('fal', { id: 'b', apiKey: 'fal:key', models: { 'image-to-3d': 'fal-ai/trellis-2' } });
    const m = createProviderConfig('replicate', { id: 'server-replicate', managed: true });
    return { providers: [a, b, m], defaults: { 'image-edit': 'b' }, rememberKeys: false };
  };

  it('keeps keys in session storage only (and never persists managed providers)', () => {
    const local = new MemStore();
    const session = new MemStore();
    saveAiSettings(local, session, settings());
    expect(local.map.get(`3dmarker:${AI_SETTINGS_KEY}`)).not.toContain('sk-a');
    expect(local.map.get(`3dmarker:${AI_SETTINGS_KEY}`)).not.toContain('server-replicate');
    expect(keysIn(local)).toBeUndefined();
    expect(JSON.parse(keysIn(session)!)).toEqual({ a: { apiKey: 'sk-a' }, b: { apiKey: 'fal:key' } });

    const loaded = loadAiSettings(local, session);
    expect(loaded.providers.map((p) => [p.id, p.apiKey, p.label])).toEqual([
      ['a', 'sk-a', 'Work'],
      ['b', 'fal:key', 'fal.ai'],
    ]);
    expect(loaded.providers[1].models['image-to-3d']).toBe('fal-ai/trellis-2');
    expect(loaded.defaults['image-edit']).toBe('b');
    expect(loaded.defaults['background-removal']).toBe('a'); // auto-picked
    // A new tab (empty session) has the providers but not the keys.
    expect(loadAiSettings(local, new MemStore()).providers.map((p) => p.apiKey)).toEqual(['', '']);
  });

  it('migrates keys between stores when rememberKeys is toggled', () => {
    const local = new MemStore();
    const session = new MemStore();
    saveAiSettings(local, session, settings());
    saveAiSettings(local, session, { ...settings(), rememberKeys: true });
    expect(keysIn(session)).toBeUndefined();
    expect(JSON.parse(keysIn(local)!).a.apiKey).toBe('sk-a');
    expect(loadAiSettings(local, null).providers[0].apiKey).toBe('sk-a');
    saveAiSettings(local, session, { ...settings(), rememberKeys: false });
    expect(keysIn(local)).toBeUndefined();
    expect(JSON.parse(keysIn(session)!).a.apiKey).toBe('sk-a');
  });

  it('clears via setItem when the store has no removeItem', () => {
    const local: KeyValueStore & { map: Map<string, string> } = {
      map: new Map(),
      getItem(k) {
        return this.map.get(k) ?? null;
      },
      setItem(k, v) {
        this.map.set(k, v);
      },
    };
    local.setItem(`3dmarker:${AI_KEYS_KEY}`, JSON.stringify({ a: { apiKey: 'sk-a' } }));
    saveAiSettings(local, new MemStore(), settings());
    expect(JSON.parse(local.map.get(`3dmarker:${AI_KEYS_KEY}`)!)).toEqual({});
  });

  it('sanitises garbage strictly', () => {
    const local = new MemStore();
    local.setItem(
      `3dmarker:${AI_SETTINGS_KEY}`,
      JSON.stringify({
        rememberKeys: 'yes',
        defaults: { 'image-edit': 'nope', 'image-to-3d': 'server-tripo', bogus: 'a' },
        providers: [
          null,
          { kind: 'midjourney', id: 'x' },
          { kind: 'openai', id: 'ok', label: 42, values: { quality: 'bogus', extra: 1 }, models: { 'image-edit': '\u0000bad' }, enabled: 'no' },
          { kind: 'openai', id: 'ok' },
          { kind: 'gemini', id: 'bad id with spaces' },
          { kind: 'fal', id: 'server-fal', managed: true },
        ],
      }),
    );
    const s = loadAiSettings(local, new MemStore());
    expect(s.rememberKeys).toBe(false);
    expect(s.providers.map((p) => p.kind)).toEqual(['openai', 'openai', 'gemini']);
    const [first, dup, gem] = s.providers;
    expect(first.id).toBe('ok');
    expect(dup.id).not.toBe('ok');
    expect(gem.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(first.label).toBe('OpenAI');
    expect(first.values).toEqual({ size: 'match', quality: 'auto', inputFidelity: 'high' });
    expect(first.models['image-edit']).toBe('gpt-image-1.5');
    expect(first.enabled).toBe(true);
    expect(s.defaults['image-edit']).toBe('ok');
    expect(s.defaults['image-to-3d']).toBe('server-tripo'); // kept until the server list arrives
    expect(Object.keys(s.defaults)).not.toContain('bogus');
    expect(loadAiSettings(null, null)).toEqual(DEFAULT_AI_SETTINGS);
  });
});

describe('providerUsable / resolveProvider', () => {
  it('explains why a config cannot be used', () => {
    expect(providerUsable(createProviderConfig('openai', { apiKey: 'sk' }), false)).toEqual({ ok: true });
    expect(providerUsable(createProviderConfig('openai', { apiKey: 'sk', enabled: false }), false).reason?.en).toMatch(/Disabled/);
    expect(providerUsable(createProviderConfig('openai'), false).reason?.en).toMatch(/key/);
    expect(providerUsable(createProviderConfig('replicate', { apiKey: 'r8' }), false).reason?.en).toMatch(/proxy/);
    expect(providerUsable(createProviderConfig('replicate', { apiKey: 'r8' }), true).ok).toBe(true);
    expect(providerUsable(createProviderConfig('stability', { managed: true }), true).ok).toBe(true);
    expect(providerUsable(createProviderConfig('openai-compatible'), false).reason?.en).toMatch(/base URL/);
    expect(providerUsable(createProviderConfig('openai-compatible', { values: { baseUrl: 'https://x/v1' } }), false).ok).toBe(true);
    expect(providerUsable(createProviderConfig('custom-http'), false).reason?.en).toMatch(/URL/);
    expect(providerUsable(createProviderConfig('custom-http', { values: { url: 'https://x', body: '{oops' } }), false).reason?.en).toMatch(/JSON/);
    expect(providerUsable(createProviderConfig('fal', { apiKey: 'k', values: { editTemplate: '{bad' } }), false).ok).toBe(false);
  });

  it('prefers the given id, then the default, then the first usable', () => {
    const a = createProviderConfig('openai', { id: 'a', apiKey: 'sk' });
    const b = createProviderConfig('gemini', { id: 'b', apiKey: 'AIza' });
    const c = createProviderConfig('replicate', { id: 'c', apiKey: 'r8' });
    const off = createProviderConfig('fal', { id: 'off', apiKey: 'k', enabled: false });
    const s: AiSettings = { providers: [a, b, c, off], defaults: { 'image-edit': 'b' }, rememberKeys: false };
    expect(resolveProvider(s, 'image-edit')?.id).toBe('b');
    expect(resolveProvider(s, 'image-edit', 'a')?.id).toBe('a');
    expect(resolveProvider(s, 'image-edit', 'off')?.id).toBe('b');
    expect(resolveProvider(s, 'image-edit', 'c')?.id).toBe('b'); // replicate needs the server
    expect(resolveProvider(s, 'image-edit', 'c', true)?.id).toBe('c');
    expect(resolveProvider(s, 'background-removal')?.id).toBe('a');
    expect(resolveProvider(s, 'image-to-3d')).toBeNull();
    expect(resolveProvider(s, 'image-to-3d', null, true)?.id).toBe('c');
    expect(usableProviders(s, 'image-edit', false).map((p) => p.id)).toEqual(['a', 'b']);
    const custom = createProviderConfig('custom-http', { id: 'h', values: { capability: 'background-removal', url: 'https://x' } });
    expect(resolveProvider({ ...s, providers: [custom] }, 'background-removal')?.id).toBe('h');
    expect(resolveProvider({ ...s, providers: [custom] }, 'image-edit')).toBeNull();
  });

  it('normalises defaults', () => {
    const a = createProviderConfig('openai', { id: 'a', apiKey: 'sk', enabled: false });
    const b = createProviderConfig('tripo', { id: 'b', apiKey: 'tsk' });
    const s = normalizeDefaults({ providers: [a, b], defaults: { 'image-edit': 'zzz', 'image-to-3d': 'a' }, rememberKeys: false });
    expect(s.defaults).toEqual({ 'image-to-3d': 'b', 'multiview-to-3d': 'b' });
  });
});

describe('server providers', () => {
  it('fetches, sanitises and merges managed providers', async () => {
    vi.stubGlobal(
      'fetch',
      fakeNet().on(
        'GET',
        '/api/ai/providers',
        json({
          providers: [
            { id: 'server-openai', kind: 'openai', label: 'OpenAI', apiKey: 'LEAK', managed: true, values: {}, models: { 'image-edit': 'gpt-image-2' }, enabled: true },
            { id: 'evil', kind: 'openai' },
            { id: 'server-x', kind: 'nope' },
          ],
          proxyKinds: ['openai', 'bogus'],
          byok: false,
        }),
      ).fetch,
    );
    const server = await fetchServerProviders();
    expect(server).toHaveLength(1);
    expect(server![0]).toMatchObject({ id: 'server-openai', managed: true, apiKey: '', models: { 'image-edit': 'gpt-image-2' } });
    expect(await fetchServerInfo()).toMatchObject({ proxyKinds: ['openai'], byok: false });

    const own = createProviderConfig('gemini', { id: 'g', apiKey: 'AIza' });
    const stale = createProviderConfig('stability', { id: 'server-stability', managed: true });
    const merged = mergeServerProviders({ providers: [own, stale], defaults: { 'background-removal': 'server-stability' }, rememberKeys: false }, server!);
    expect(merged.providers.map((p) => p.id)).toEqual(['g', 'server-openai']);
    expect(merged.defaults).toEqual({ 'image-edit': 'g', 'background-removal': 'server-openai' });
  });

  it('returns null without a server', async () => {
    vi.stubGlobal('fetch', fakeNet().on(null, /./, new TypeError('Failed to fetch')).fetch);
    expect(await fetchServerProviders()).toBeNull();
    vi.stubGlobal('fetch', fakeNet().on(null, /./, new Response('<html>404</html>', { status: 404, headers: { 'content-type': 'text/html' } })).fetch);
    expect(await fetchServerProviders()).toBeNull();
    vi.stubGlobal('fetch', fakeNet().on(null, /./, new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })).fetch);
    expect(await fetchServerProviders()).toBeNull();
    vi.stubGlobal('fetch', fakeNet().on(null, /./, json({ providers: [] })).fetch);
    expect(await fetchServerProviders()).toEqual([]);
  });
});

describe('current settings snapshot', () => {
  it('publishes the UI settings for drivers', () => {
    expect(currentAiSettings().serverAvailable).toBe(false);
    const s: AiSettings = { providers: [createProviderConfig('openai', { apiKey: 'sk' })], defaults: {}, rememberKeys: true };
    setCurrentAiSettings(s, true);
    expect(currentAiSettings()).toEqual({ settings: s, serverAvailable: true });
    setCurrentAiSettings(DEFAULT_AI_SETTINGS, false);
  });
});
