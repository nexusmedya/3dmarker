import { describe, expect, it } from 'vitest';
import {
  EXTRA_BASE_ROUTES,
  PROXY_KINDS,
  allServerKeys,
  byokEnabled,
  enabledProxyKinds,
  isAllowedRoute,
  managedProviders,
  normalizeBase,
  parseExtraBases,
  serverKeyFor,
} from './providers';

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
    expect(enabledProxyKinds({})).toEqual(['openai', 'gemini', 'stability', 'replicate', 'fal']);
  });

  it('keeps Tripo out of the generic proxy but still announces its managed entry', () => {
    expect(Object.keys(PROXY_KINDS)).not.toContain('tripo');
    expect(enabledProxyKinds({ AI_PROXY_KINDS: 'tripo,fal' })).toEqual(['fal']);
    // The tripo adapter uses /api/tripo/*, which TRIPO_API_KEY serves regardless of AI_PROXY_KINDS.
    expect(managedProviders({ TRIPO_API_KEY: 'tsk_x', AI_PROXY_KINDS: 'fal' })).toEqual([
      expect.objectContaining({ id: 'server-tripo', kind: 'tripo', managed: true, apiKey: '' }),
    ]);
    expect(allServerKeys({ TRIPO_API_KEY: 'tsk_x' })).toEqual(['tsk_x']);
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

describe('endpoint allow-lists', () => {
  const ok = (kind: keyof typeof PROXY_KINDS, method: string, path: string) => isAllowedRoute(PROXY_KINDS[kind].allow, method, path);

  it('allows what the adapters call', () => {
    const allowed: [keyof typeof PROXY_KINDS, string, string][] = [
      ['openai', 'POST', 'v1/images/edits'],
      ['openai', 'GET', 'v1/models'],
      ['gemini', 'POST', 'v1beta/models/gemini-2.5-flash-image:generateContent'],
      ['gemini', 'GET', 'v1beta/models'],
      ['stability', 'POST', 'v2beta/stable-image/edit/remove-background'],
      ['stability', 'POST', 'v2beta/stable-image/control/sketch'],
      ['stability', 'POST', 'v2beta/3d/stable-fast-3d'],
      ['stability', 'GET', 'v1/user/account'],
      ['replicate', 'POST', 'v1/predictions'],
      ['replicate', 'POST', 'v1/models/black-forest-labs/flux-kontext-pro/predictions'],
      ['replicate', 'GET', 'v1/predictions/abc123'],
      ['replicate', 'POST', 'v1/predictions/abc123/cancel'],
      ['replicate', 'GET', 'v1/account'],
      ['fal', 'POST', 'queue/fal-ai/trellis'],
      ['fal', 'POST', 'queue/fal-ai/flux-pro/kontext/max'],
      ['fal', 'GET', 'queue/fal-ai/flux-pro/requests/0f1e-2d3c/status'],
      ['fal', 'GET', 'queue/workflows/me/flow/requests/abc'],
      ['fal', 'PUT', 'queue/fal-ai/trellis/requests/abc/cancel'],
    ];
    for (const [kind, method, path] of allowed) expect(ok(kind, method, path), `${kind} ${method} ${path}`).toBe(true);
  });

  it('refuses account data, other resources and other methods', () => {
    const refused: [keyof typeof PROXY_KINDS, string, string][] = [
      ['openai', 'GET', 'v1/files'],
      ['openai', 'GET', 'v1/files/file-abc/content'],
      ['openai', 'DELETE', 'v1/files/file-abc'],
      ['openai', 'POST', 'v1/fine_tuning/jobs'],
      ['openai', 'POST', 'v1/chat/completions'],
      ['openai', 'GET', 'v1/images/edits'],
      ['gemini', 'GET', 'v1beta/files'],
      ['gemini', 'GET', 'v1beta/tunedModels'],
      ['gemini', 'POST', 'v1beta/models/x:streamGenerateContent'],
      ['replicate', 'GET', 'v1/predictions'],
      ['replicate', 'GET', 'v1/trainings'],
      ['replicate', 'POST', 'v1/deployments'],
      ['replicate', 'POST', 'v1/models/o/n/versions/v/trainings'],
      ['replicate', 'DELETE', 'v1/predictions/abc'],
      ['fal', 'POST', 'fal-ai/veo3'],
      ['fal', 'POST', 'queue/fal-ai/x/requests/abc'],
      ['fal', 'GET', 'queue/fal-ai/x'],
      ['stability', 'GET', 'v1/user/balance'],
      ['stability', 'POST', 'v1/generation/x/text-to-image'],
    ];
    for (const [kind, method, path] of refused) expect(ok(kind, method, path), `${kind} ${method} ${path}`).toBe(false);
  });

  it('extra bases: only the OpenAI-compatible image edit and model list', () => {
    expect(isAllowedRoute(EXTRA_BASE_ROUTES, 'POST', 'images/edits')).toBe(true);
    expect(isAllowedRoute(EXTRA_BASE_ROUTES, 'GET', 'models')).toBe(true);
    for (const [m, p] of [['POST', 'chat/completions'], ['POST', 'completions'], ['POST', 'embeddings'], ['DELETE', 'models']]) {
      expect(isAllowedRoute(EXTRA_BASE_ROUTES, m, p), p).toBe(false);
    }
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
