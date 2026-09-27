/**
 * Studio shell UX: opaque plain-background images get a mask in the default
 * background mode, samples pick their driver, a failed model download offers
 * an offline driver, step tabs never truncate, camera presets, and the
 * phone layout (scroll to the result, scrollable step tabs, page scroll over
 * the viewer, step footer). Model downloads are cut off (offline).
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { Raster } from './png';

async function offline(context: BrowserContext) {
  await context.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net|storage\.googleapis\.com/, (r) => r.abort('internetdisconnected'));
}

async function open(page: Page, lang: 'tr' | 'en' = 'en') {
  await page.goto('/');
  await page.getByTestId(`lang-${lang}`).click();
}

const SAMPLE = { mascot: 1, tpose: 3 } as const;

/** A person-ish figure on an opaque off-white background (no alpha), like a phone photo or a drawing. */
function personOnWhite(): Buffer {
  const r = new Raster(120, 180);
  r.rect(0, 0, 1, 1, [245, 245, 245, 255]);
  r.ellipse(0.5, 0.18, 0.1, 0.08, [224, 172, 140, 255]);
  r.rect(0.36, 0.26, 0.64, 0.6, [200, 40, 40, 255]);
  r.rect(0.38, 0.6, 0.48, 0.95, [30, 50, 120, 255]);
  r.rect(0.52, 0.6, 0.62, 0.95, [30, 50, 120, 255]);
  return r.png();
}

async function generated(page: Page) {
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', /^[1-9]\d*$/, { timeout: 60_000 });
}

test.describe('first-time journey', () => {
  test('an opaque image on a plain background is masked in the default (auto) mode', async ({ page, context }) => {
    await offline(context);
    await open(page, 'tr');
    await expect(page.getByTestId('bg-select')).toHaveValue('auto');
    await page.getByTestId('file-input').setInputFiles({ name: 'kisi.png', mimeType: 'image/png', buffer: personOnWhite() });
    await expect(page.locator('.preview-meta')).toContainText('Ön plan: %');
    await expect(page.getByTestId('mask-toggle')).toBeEnabled();
    await expect(page.getByText('tüm görsel kullanılacak')).toHaveCount(0);
  });

  test('samples select their recommended driver', async ({ page, context }) => {
    await offline(context);
    await open(page);
    await page.getByTestId(`sample-${SAMPLE.tpose}`).click();
    await expect(page.getByTestId('generate')).toBeEnabled();
    await page.getByTestId('step-3d').click();
    await expect(page.getByTestId('driver-select')).toHaveValue('multiview-fusion');
    await expect(page.getByTestId('generate-views-unused')).toHaveCount(0);
    await page.getByTestId('step-image').click();
    await page.getByTestId(`sample-${SAMPLE.mascot}`).click();
    await page.getByTestId('step-3d').click();
    await expect(page.getByTestId('driver-select')).toHaveValue('silhouette-inflate');
  });

  test('a failed model download offers the offline driver; the technical detail stays folded', async ({ page, context }) => {
    await offline(context);
    await open(page, 'tr');
    await page.getByTestId('file-input').setInputFiles({ name: 'kisi.png', mimeType: 'image/png', buffer: personOnWhite() });
    await page.getByTestId('step-3d').click();
    await page.getByTestId('driver-select').selectOption('depth-anything-v2-small');
    await page.getByTestId('generate').click();
    const error = page.getByTestId('error');
    await expect(error).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('error-detail')).toBeVisible();
    await expect(page.getByTestId('error-detail').locator('code')).toBeHidden();
    const action = page.getByTestId('error-action');
    await expect(action).toContainText('Siluet şişirme ile dene');
    await action.click();
    await generated(page);
    await expect(page.getByTestId('driver-select')).toHaveValue('silhouette-inflate');
    await expect(error).toHaveCount(0);
  });

  test('step tabs keep their full labels at laptop width once a model exists (TR)', async ({ page, context }) => {
    await offline(context);
    await open(page, 'tr');
    await page.getByTestId(`sample-${SAMPLE.mascot}`).click();
    await page.getByTestId('step-views').click();
    await page.getByTestId('generate').click();
    await generated(page);
    const clipped = await page.locator('.stepnav-label').evaluateAll((els) =>
      els.filter((e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1).map((e) => e.textContent),
    );
    expect(clipped).toEqual([]);
    const nav = page.locator('.stepnav');
    expect(await nav.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
  });

  test('camera presets look at the model straight from a side', async ({ page, context }) => {
    await offline(context);
    await open(page);
    await page.getByTestId(`sample-${SAMPLE.mascot}`).click();
    await page.getByTestId('generate').click();
    await generated(page);
    await page.getByTestId('camera-presets').click();
    const dir = () =>
      page.evaluate(() => {
        const v = (window as unknown as { __3dmarkerViewer: { camera: { position: { x: number; y: number; z: number } }; controls: { target: { x: number; y: number; z: number } } } }).__3dmarkerViewer;
        const p = v.camera.position, t = v.controls.target;
        const d = [p.x - t.x, p.y - t.y, p.z - t.z];
        const l = Math.hypot(...d);
        return d.map((c) => c / l);
      });
    await page.getByTestId('camera-top').click();
    expect((await dir())[1]).toBeGreaterThan(0.99);
    await page.getByTestId('camera-left').click();
    expect((await dir())[0]).toBeGreaterThan(0.99);
    await page.getByTestId('camera-back').click();
    expect((await dir())[2]).toBeLessThan(-0.99);
  });
});

test.describe('phone layout', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('step tabs show they scroll, the footer fits, and generating brings the model into view', async ({ page, context }) => {
    await offline(context);
    await open(page, 'tr');
    const nav = page.locator('.stepnav');
    await expect(nav).toHaveClass(/can-scroll-end/);
    await nav.evaluate((e) => e.scrollTo({ left: e.scrollWidth }));
    await expect(nav).not.toHaveClass(/can-scroll-end/);
    await expect(nav).toHaveClass(/can-scroll-start/);

    await page.getByTestId(`sample-${SAMPLE.mascot}`).click();
    await page.getByTestId('step-3d').click();
    const footer = page.locator('#step-panel-3d .step-footer');
    expect(await footer.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);

    // Tap Generate from the panel: the viewer must come on screen when it is done.
    await page.getByTestId('generate').click();
    await generated(page);
    await expect
      .poll(async () => {
        const box = await page.getByTestId('stage').boundingBox();
        return !!box && box.y < 812 * 0.6 && box.y + box.height > 0;
      })
      .toBe(true);
  });

  test('a vertical swipe over the viewer scrolls the page (not sculpting)', async ({ page, context }) => {
    await offline(context);
    await open(page);
    const canvas = page.getByTestId('viewer').locator('canvas');
    await expect(canvas).toHaveCSS('touch-action', 'pan-y');
  });
});

test.describe('desktop does not scroll on generate', () => {
  test('the page stays put after generating', async ({ page, context }) => {
    await offline(context);
    await open(page);
    await page.getByTestId(`sample-${SAMPLE.mascot}`).click();
    const before = await page.evaluate(() => window.scrollY);
    await page.getByTestId('generate').click();
    await generated(page);
    expect(await page.evaluate(() => window.scrollY)).toBe(before);
    await expect(page.getByTestId('viewer').locator('canvas')).toHaveCSS('touch-action', 'none');
  });
});
