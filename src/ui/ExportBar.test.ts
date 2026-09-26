// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Group } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { Lang } from '../core/types';
import type { ResultInfo } from '../app/store';
import { LangProvider } from './i18n';

vi.mock('../core/export/exporters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/export/exporters')>();
  return {
    ...actual,
    exportObject: vi.fn(async () => {
      throw Object.assign(new Error('x'), { i18n: { tr: 'disk dolu', en: 'disk full' } });
    }),
    downloadBlob: vi.fn(),
  };
});

import { downloadBlob, exportObject } from '../core/export/exporters';
import { ExportBar } from './ExportBar';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const result: ResultInfo = {
  driverId: 'silhouette-inflate',
  kind: 'depth',
  stats: { vertices: 1, triangles: 1, watertight: true },
  depthPreview: null,
  elapsedMs: 1,
  sourceName: 'a.png',
};

describe('ExportBar', () => {
  it('re-localises the export error when the language changes', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const view = (lang: Lang) =>
      createElement(
        LangProvider,
        { value: lang },
        createElement(ExportBar, { result, getObject: () => new Group(), stlSizeMm: 100, onStlSize: () => {}, disabled: false }),
      );
    await act(async () => root.render(view('en')));
    await act(async () => {
      (host.querySelector('[data-testid="export-glb"]') as HTMLButtonElement).click();
      // The export waits for a paint first; the failure is logged right before the state update.
      await vi.waitFor(() => expect(logged).toHaveBeenCalled());
    });
    const alert = () => host.querySelector('[role="alert"]')?.textContent ?? '';
    expect(alert()).toContain('Export failed: disk full');
    await act(async () => root.render(view('tr')));
    expect(alert()).toContain('Dışa aktarma başarısız: disk dolu');
    await act(async () => root.unmount());
  });

  it('shows the busy state before the (synchronous) export starts', async () => {
    let finish!: (blob: Blob) => void;
    vi.mocked(exportObject).mockImplementationOnce(() => new Promise<Blob>((r) => (finish = r)));
    const calls = vi.mocked(exportObject).mock.calls.length;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () =>
      root.render(
        createElement(
          LangProvider,
          { value: 'en' as Lang },
          createElement(ExportBar, { result, getObject: () => new Group(), stlSizeMm: 100, onStlSize: () => {}, disabled: false }),
        ),
      ),
    );
    const stl = host.querySelector('[data-testid="export-stl"]') as HTMLButtonElement;
    await act(async () => stl.click());
    // Rendered busy (spinner, buttons disabled) while the export has not started yet.
    expect(stl.getAttribute('aria-busy')).toBe('true');
    expect(stl.disabled).toBe(true);
    expect(vi.mocked(exportObject).mock.calls.length).toBe(calls);
    await act(async () => {
      await vi.waitFor(() => expect(vi.mocked(exportObject).mock.calls.length).toBe(calls + 1));
      finish(new Blob(['x']));
    });
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    expect(stl.getAttribute('aria-busy')).toBe('false');
    await act(async () => root.unmount());
  });
});
