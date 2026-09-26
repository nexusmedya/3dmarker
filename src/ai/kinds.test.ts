import { describe, expect, it } from 'vitest';
import { AI_CAPABILITIES } from './types';
import { configCapabilities, defaultModel, getProviderKind, isProviderKindId, kindNeedsKey, migrateOutputPath, outputPathKey, PROVIDER_KINDS, templateKey } from './kinds';
import { getAdapter } from './adapters';
import { createProviderConfig } from './settings';

describe('PROVIDER_KINDS', () => {
  it('lists every kind once, each with an adapter implementing its capabilities', () => {
    const ids = PROVIDER_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(['custom-http', 'fal', 'gemini', 'openai', 'openai-compatible', 'replicate', 'stability', 'tripo']);
    for (const kind of PROVIDER_KINDS) {
      const adapter = getAdapter(kind.id);
      expect(adapter.kind).toBe(kind.id);
      expect(kind.name).not.toBe('');
      expect(kind.description.tr && kind.description.en).toBeTruthy();
      for (const cap of kind.capabilities) {
        expect(AI_CAPABILITIES).toContain(cap);
        const method = cap === 'image-edit' ? 'editImage' : cap === 'background-removal' ? 'removeBackground' : 'toModel';
        expect(typeof adapter[method]).toBe('function');
        if (kind.id !== 'custom-http') expect(kind.models[cap]?.length).toBeGreaterThan(0);
      }
      const keys = kind.fields.map((f) => f.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('declares browser-direct kinds as verified / assumed', () => {
    const direct = PROVIDER_KINDS.filter((k) => k.browserDirect).map((k) => k.id).sort();
    expect(direct).toEqual(['custom-http', 'fal', 'gemini', 'openai', 'openai-compatible']);
  });

  it('offers generic templates on replicate and fal', () => {
    for (const id of ['replicate', 'fal'] as const) {
      const keys = getProviderKind(id).fields.map((f) => f.key);
      for (const cap of AI_CAPABILITIES) expect(keys).toContain(templateKey(cap));
      // One output path per capability, so a 3D path never breaks image edits of the same entry.
      for (const cap of AI_CAPABILITIES) expect(keys).toContain(outputPathKey(cap));
      expect(keys).not.toContain('outputPath');
    }
  });

  it('migrates the old single output path to the capabilities it was meant for', () => {
    // A custom template marks the capability the path belongs to.
    expect(migrateOutputPath('fal', { outputPath: 'result.mesh', multiviewTemplate: '{"f":"{{front}}"}' })).toEqual({ multiviewTemplate: '{"f":"{{front}}"}', multiviewOutputPath: 'result.mesh' });
    // Otherwise a model-looking path goes to the 3D capabilities only, an image path to the image ones.
    expect(migrateOutputPath('fal', { outputPath: 'model_glb.url' })).toEqual({ modelOutputPath: 'model_glb.url', multiviewOutputPath: 'model_glb.url' });
    expect(migrateOutputPath('replicate', { outputPath: 'images.0.url' })).toEqual({ editOutputPath: 'images.0.url', bgOutputPath: 'images.0.url' });
    expect(migrateOutputPath('fal', { outputPath: 'x', editOutputPath: 'own' })).toMatchObject({ editOutputPath: 'own' });
    expect(migrateOutputPath('custom-http', { outputPath: 'x' })).toEqual({ outputPath: 'x' });
    const cfg = createProviderConfig('fal', { values: { outputPath: 'model_glb.url' } });
    expect(cfg.values.modelOutputPath).toBe('model_glb.url');
    expect(cfg.values.editOutputPath).toBe('');
  });

  it('helpers', () => {
    expect(isProviderKindId('openai')).toBe(true);
    expect(isProviderKindId('dall-e')).toBe(false);
    expect(() => getProviderKind('nope' as never)).toThrow();
    expect(kindNeedsKey('openai')).toBe(true);
    expect(kindNeedsKey('custom-http')).toBe(false);
    expect(defaultModel('gemini', 'image-edit')).toBe('gemini-2.5-flash-image');
    expect(defaultModel('gemini', 'image-to-3d')).toBe('');
    expect(configCapabilities(createProviderConfig('custom-http', { values: { capability: 'image-to-3d' } }))).toEqual(['image-to-3d']);
    expect(configCapabilities(createProviderConfig('tripo'))).toEqual(['image-to-3d', 'multiview-to-3d']);
  });
});
