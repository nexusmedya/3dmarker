// @vitest-environment jsdom
/**
 * ProviderSettingsDialog in a DOM: the add / edit / remove flows produce the
 * right AiSettings through onChange (a harness feeds them back like the
 * shell does), managed entries have no key field, the connection test uses
 * the kind's adapter, Esc / Done close, focus stays inside.
 */
import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { AiSettings, ProviderConfig } from '../../ai/types';
import { createProviderConfig, DEFAULT_AI_SETTINGS } from '../../ai/settings';

const mocks = vi.hoisted(() => ({ testConnection: vi.fn() }));
vi.mock('../../ai/adapters', () => ({
  getAdapter: (kind: string) => (kind === 'custom-http' ? { kind } : { kind, testConnection: mocks.testConnection }),
}));

import { ProviderSettingsDialog } from './ProviderSettingsDialog';
import { byTestId, cleanup, click, keyDown, mount, queryTestId, selectValue, typeInto } from './testing';

let latest: AiSettings;
let onChange: Mock<(s: AiSettings) => void>;
let onClose: Mock<() => void>;

function Harness({ initial, serverAvailable }: { initial: AiSettings; serverAvailable: boolean }) {
  const [s, setS] = useState(initial);
  return createElement(ProviderSettingsDialog, {
    open: true,
    onClose,
    settings: s,
    serverAvailable,
    onChange: (next: AiSettings) => {
      latest = next;
      onChange(next);
      setS(next);
    },
  });
}

function open(initial: AiSettings = DEFAULT_AI_SETTINGS, serverAvailable = false, lang: 'tr' | 'en' = 'en') {
  latest = initial;
  return mount(createElement(Harness, { initial, serverAvailable }), lang);
}

const withProviders = (...providers: ProviderConfig[]): AiSettings => ({ providers, defaults: {}, rememberKeys: false });

beforeEach(() => {
  onChange = vi.fn<(s: AiSettings) => void>();
  onClose = vi.fn<() => void>();
  mocks.testConnection.mockReset();
});
afterEach(cleanup);

describe('ProviderSettingsDialog', () => {
  it('renders nothing while closed', () => {
    mount(createElement(ProviderSettingsDialog, { open: false, onClose: vi.fn(), settings: DEFAULT_AI_SETTINGS, onChange: vi.fn(), serverAvailable: false }));
    expect(queryTestId('ai-settings-dialog')).toBeNull();
  });

  it('is a labelled modal in a portal and starts on the kind chooser when empty', () => {
    open();
    const dialog = byTestId('ai-settings-dialog');
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const title = document.getElementById(dialog.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('AI providers');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(document.activeElement).toBe(dialog);
    expect(queryTestId('ai-kind-chooser')).not.toBeNull();
    expect(queryTestId('ai-kind-openai')).not.toBeNull();
    expect(queryTestId('ai-kind-custom-http')).not.toBeNull();
    // Static demo note: names the browser-direct kinds and the server-only ones.
    expect(byTestId('ai-no-server').textContent).toContain('OpenAI');
    expect(byTestId('ai-no-server').textContent).toContain('Replicate');
  });

  it('hides the no-server note when a server is there', () => {
    open(DEFAULT_AI_SETTINGS, true);
    expect(queryTestId('ai-no-server')).toBeNull();
  });

  it('adds a provider, types its key, label and a custom model', () => {
    open();
    click(byTestId('ai-add-kind-openai'));
    expect(latest.providers).toHaveLength(1);
    const cfg = latest.providers[0];
    expect(cfg).toMatchObject({ kind: 'openai', label: 'OpenAI', apiKey: '', enabled: true });
    expect(latest.defaults['image-edit']).toBe(cfg.id);
    // The editor opens with the key field focused.
    const key = byTestId<HTMLInputElement>(`ai-key-${cfg.id}`);
    expect(key.type).toBe('password');
    expect(document.activeElement).toBe(key);
    expect(byTestId(`ai-status-${cfg.id}`).textContent).toContain('No API key entered.');

    typeInto(key, 'sk-test-123');
    expect(latest.providers[0].apiKey).toBe('sk-test-123');
    expect(byTestId(`ai-status-${cfg.id}`).textContent).toContain('Ready to use');
    expect(byTestId(`ai-provider-${cfg.id}`).textContent).toContain('Ready to use');

    typeInto(byTestId<HTMLInputElement>(`ai-label-${cfg.id}`), 'OpenAI work ');
    expect(latest.providers[0].label).toBe('OpenAI work '); // not trimmed while typing

    selectValue(byTestId<HTMLSelectElement>(`ai-model-${cfg.id}-image-edit`), 'gpt-image-1-mini');
    expect(latest.providers[0].models['image-edit']).toBe('gpt-image-1-mini');
    selectValue(byTestId<HTMLSelectElement>(`ai-model-${cfg.id}-image-edit`), '__custom__');
    typeInto(byTestId<HTMLInputElement>(`ai-model-custom-${cfg.id}-image-edit`), 'my-image-model');
    expect(latest.providers[0].models['image-edit']).toBe('my-image-model');
    expect(byTestId<HTMLSelectElement>(`ai-model-${cfg.id}-image-edit`).value).toBe('__custom__');

    // Kind fields through the generic form.
    const quality = byTestId('param-quality').querySelector('select')!;
    selectValue(quality, 'high');
    expect(latest.providers[0].values.quality).toBe('high');
  });

  it('adds several of the same kind with distinct labels and switches defaults', () => {
    open();
    click(byTestId('ai-add-kind-gemini'));
    click(byTestId('ai-add-provider'));
    click(byTestId('ai-add-kind-gemini'));
    expect(latest.providers.map((p) => p.label)).toEqual(['Google Gemini', 'Google Gemini 2']);
    const [a, b] = latest.providers;
    expect(latest.defaults['image-edit']).toBe(a.id);
    selectValue(byTestId<HTMLSelectElement>('ai-default-image-edit'), b.id);
    expect(latest.defaults['image-edit']).toBe(b.id);
    // Editor chip: the selected entry (b) is the default now.
    expect(byTestId(`ai-default-${b.id}-image-edit`).getAttribute('aria-pressed')).toBe('true');
    click(byTestId(`ai-select-${a.id}`));
    click(byTestId(`ai-default-${a.id}-image-edit`));
    expect(latest.defaults['image-edit']).toBe(a.id);
    // No provider offers image-to-3D: its default select is disabled.
    expect(byTestId<HTMLSelectElement>('ai-default-image-to-3d').disabled).toBe(true);
  });

  it('toggles enabled and deletes after confirming', () => {
    const a = createProviderConfig('openai', { id: 'p-a', apiKey: 'sk-a' });
    const b = createProviderConfig('fal', { id: 'p-b', apiKey: 'k:s' });
    open({ ...withProviders(a, b), defaults: { 'image-edit': 'p-b' } });
    click(byTestId('ai-enabled-p-a'));
    expect(latest.providers[0].enabled).toBe(false);
    expect(byTestId('ai-provider-p-a').textContent).toContain('Disabled.');

    click(byTestId('ai-select-p-b'));
    click(byTestId('ai-delete-p-b'));
    expect(onChange).toHaveBeenCalledTimes(1); // asking does not delete
    // Esc cancels the confirmation, not the dialog.
    keyDown(byTestId('ai-settings-dialog'), 'Escape');
    expect(onClose).not.toHaveBeenCalled();
    expect(queryTestId('ai-delete-confirm-p-b')).toBeNull();
    click(byTestId('ai-delete-p-b'));
    click(byTestId('ai-delete-confirm-p-b'));
    expect(latest.providers.map((p) => p.id)).toEqual(['p-a']);
    // The default pointed at the deleted entry; the one left is disabled, so none is picked…
    expect(latest.defaults['image-edit']).toBeUndefined();
    click(byTestId('ai-enabled-p-a'));
    // …until it is enabled again.
    expect(latest.defaults['image-edit']).toBe('p-a');
    expect(queryTestId('ai-provider-p-b')).toBeNull();
    expect(queryTestId('ai-editor-p-a')).not.toBeNull();
  });

  it('shows managed entries without a key field and without delete', () => {
    const managed = createProviderConfig('tripo', { id: 'server-tripo', label: 'Tripo (server)', managed: true });
    open(withProviders(managed), true);
    const row = byTestId('ai-provider-server-tripo');
    expect(row.textContent).toContain('Server');
    expect(queryTestId('ai-key-server-tripo')).toBeNull();
    expect(queryTestId('ai-managed-server-tripo')).not.toBeNull();
    expect(queryTestId('ai-delete-server-tripo')).toBeNull();
    expect(byTestId('ai-status-server-tripo').textContent).toContain('Ready to use');
  });

  it('tests the connection with the kind adapter and shows the result', async () => {
    const cfg = createProviderConfig('openai', { id: 'p-t', apiKey: 'sk-x' });
    open(withProviders(cfg));
    let resolve!: (v: { ok: boolean }) => void;
    mocks.testConnection.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    click(byTestId('ai-test-p-t'));
    expect(mocks.testConnection).toHaveBeenCalledWith(expect.objectContaining({ id: 'p-t', apiKey: 'sk-x' }), expect.any(AbortSignal));
    expect(byTestId<HTMLButtonElement>('ai-test-p-t').disabled).toBe(true);
    await actAsync(() => resolve({ ok: true }));
    expect(byTestId('ai-test-result-p-t').textContent).toContain('Connection works.');

    const err = Object.assign(new Error('bad'), { i18n: { tr: 'Anahtar geçersiz.', en: 'Invalid key.' } });
    mocks.testConnection.mockRejectedValueOnce(err);
    await actAsync(() => click(byTestId('ai-test-p-t')));
    expect(byTestId('ai-test-result-p-t').textContent).toContain('Connection failed: Invalid key.');
    // Editing the config hides the stale result.
    typeInto(byTestId<HTMLInputElement>('ai-key-p-t'), 'sk-y');
    expect(byTestId('ai-test-result-p-t').textContent).toBe('');
  });

  it('cannot test without a key or on kinds without a test', () => {
    open(withProviders(createProviderConfig('openai', { id: 'p-n' }), createProviderConfig('custom-http', { id: 'p-c' })));
    expect(byTestId<HTMLButtonElement>('ai-test-p-n').disabled).toBe(true);
    click(byTestId('ai-select-p-c'));
    expect(byTestId<HTMLButtonElement>('ai-test-p-c').disabled).toBe(true);
    expect(byTestId('ai-test-result-p-c').textContent).toContain('No connection test');
  });

  it('toggles "remember keys"', () => {
    open(withProviders(createProviderConfig('openai', { id: 'p-r' })));
    click(byTestId('ai-remember-keys'));
    expect(latest.rememberKeys).toBe(true);
    expect(document.body.textContent).toContain('never stores or logs them');
  });

  it('closes with Esc, Done and the close button, and keeps Tab inside', () => {
    open(withProviders(createProviderConfig('openai', { id: 'p-f' })));
    const dialog = byTestId('ai-settings-dialog');
    const esc = keyDown(dialog, 'Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(esc.defaultPrevented).toBe(true);
    click(byTestId('ai-save'));
    click(byTestId('ai-close'));
    expect(onClose).toHaveBeenCalledTimes(3);

    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]'));
    focusables[focusables.length - 1].focus();
    const tab = keyDown(dialog, 'Tab');
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[0]);
    const back = keyDown(dialog, 'Tab', { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(focusables[focusables.length - 1]);
  });

  it('speaks Turkish', () => {
    open(DEFAULT_AI_SETTINGS, false, 'tr');
    expect(byTestId('ai-settings-dialog').textContent).toContain('Yapay zekâ sağlayıcıları');
    expect(byTestId('ai-add-provider').textContent).toContain('Sağlayıcı ekle');
  });
});

async function actAsync(fn: () => void): Promise<void> {
  const { act } = await import('react');
  await act(async () => {
    fn();
    await Promise.resolve();
  });
}
