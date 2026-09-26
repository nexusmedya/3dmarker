import { describe, expect, it } from 'vitest';
import { PROVIDER_KINDS, hasConnectionTest } from '../kinds';
import { getAdapter } from './index';

describe('getAdapter', () => {
  it('has an adapter for every kind, and the settings dialog knows which ones can test the connection', () => {
    for (const k of PROVIDER_KINDS) {
      const adapter = getAdapter(k.id);
      expect(adapter).toBeTruthy();
      expect(hasConnectionTest(k.id)).toBe(typeof adapter.testConnection === 'function');
    }
  });
});
