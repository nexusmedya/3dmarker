import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW } from '../app/store';
import { LangProvider } from './i18n';
import { Viewer } from './Viewer';

const render = (hasSource: boolean) =>
  renderToStaticMarkup(
    createElement(
      LangProvider,
      { value: 'en' },
      createElement(Viewer, {
        model: null,
        geometryVersion: 0,
        view: DEFAULT_VIEW,
        onView: () => {},
        coreRef: { current: null },
        depthPreview: null,
        running: false,
        progress: null,
        hasSource,
      }),
    ),
  );

describe('Viewer empty state', () => {
  it('asks for an image only while none is loaded', () => {
    expect(render(false)).toContain('Upload an image, pick a driver');
    const loaded = render(true);
    expect(loaded).not.toContain('Upload an image');
    expect(loaded).toContain('Image loaded — finish the steps on the left');
  });
});
