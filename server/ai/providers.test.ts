import { describe, expect, it } from 'vitest';
import { allServerKeys, byokEnabled, enabledProxyKinds, managedProviders, normalizeBase, parseExtraBases, serverKeyFor } from './providers';

describe('managedProviders', () => {
  it('announces one managed entry per configured key, never the key', () => {
    const env = {
      OPENAI_API_KEY: 'sk-server-openai-1234567890',
      OPENAI_IMAGE_MODEL: ' gpt-image-1 ',
      GEMINI_API_KEY: '  ',
      STABILITY_API_KEY: 'sk-stab',
      REPLICATE_API_TOKEN: 'r8_x',
      FAL_KEY: 'id:secret',
      TRIPO_API_KEY: 'tsk_x',
    };
    const list = managedProviders(env);
    expect(list.map((p) => p.id)).toEqual(['server-openai', 'server-stability', 'server-replicate', 'server-fal', 'server-tripo']);
    expect(list[0]).toEqual({
      id: 'server-openai',
      kind: 'openai',
      label: 'OpenAI',
      apiKey: '',
      managed: true,
      values: {},
      models: { 'image-edit': 'gpt-image-1' },
      enabled: true,
    });
    expect(list.every((p) => p.managed && p.apiKey === '' && p.enabled)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/sk-server|sk-stab|r8_x|secret|tsk_x/);
    expect(managedProviders({ GEMINI_API_KEY: 'AIza', GEMINI_IMAGE_MODEL: 'gemini-2.5-flash-image' })).toEqual([
      expect.objectContaining({ id: 'server-gemini', kind: 'gemini', models: { 'image-edit': 'gemini-2.5-flash-image' } }),
    ]);
    expect(managedProviders({})).toEqual([]);
  });

  it('honours AI_PROXY_KINDS', () => {
    const env = { OPENAI_API_KEY: 'a', FAL_KEY: 'b', AI_PROXY_KINDS: 'fal, nonsense' };
    expect(enabledProxyKinds(env)).toEqual(['fal']);
    expect(managedProviders(env).map((p) => p.kind)).toEqual(['fal']);
    expect(enabledProxyKinds({})).toEqual(['openai', 'gemini', 'stability', 'replicate', 'fal', 'tripo']);
  });

  it('server keys and BYOK flag', () => {
    expect(serverKeyFor({ FAL_KEY: ' k ' }, 'fal')).toBe('k');
    expect(serverKeyFor({}, 'fal')).toBeNull();
    expect(allServerKeys({ FAL_KEY: 'k', OPENAI_API_KEY: 'o' }).sort()).toEqual(['k', 'o']);
    expect(byokEnabled({})).toBe(true);
    for (const v of ['0', 'false', 'OFF', 'no']) expect(byokEnabled({ AI_PROXY_BYOK: v }), v).toBe(false);
    expect(byokEnabled({ AI_PROXY_BYOK: '1' })).toBe(true);
  });
});

describe('extra bases', () => {
  it('normalises and validates', () => {
    expect(normalizeBase('https://LLM.example.com/v1/')).toBe('https://llm.example.com/v1');
    expect(normalizeBase('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1');
    expect(normalizeBase('https://a.com')).toBe('https://a.com');
    for (const bad of ['ftp://a.com', 'https://u:p@a.com', 'https://a.com/?x=1', 'https://a.com/#x', 'nope']) expect(normalizeBase(bad), bad).toBeNull();
    expect(parseExtraBases(' https://a.com/v1/ , bad, http://localhost:8000 ')).toEqual(['https://a.com/v1', 'http://localhost:8000']);
    expect(parseExtraBases(undefined)).toEqual([]);
  });
});
