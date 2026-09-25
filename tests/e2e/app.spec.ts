/**
 * End-to-end tests of the studio in a real browser (Chromium + SwiftShader
 * WebGL) against the Vite dev server and the API server (no Tripo key).
 * Screenshots land in test-results/screenshots/ for manual inspection.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { DRIVERS } from '../../src/drivers';
import { buildCubeGlb } from './glb';

const SHOTS = 'test-results/screenshots';

/** Sample buttons (see src/app/samples.ts): 0 = star logo, 1 = mascot, 2 = landscape photo. */
const SAMPLE = { logo: 0, mascot: 1, landscape: 2 } as const;

const OFFLINE_CASES = [
  { driver: 'silhouette-inflate', sample: SAMPLE.mascot },
  { driver: 'silhouette-extrude', sample: SAMPLE.logo },
  { driver: 'luminance-heightmap', sample: SAMPLE.landscape },
] as const;

/** Console errors and uncaught exceptions seen by the page. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, lang: 'en' | 'tr' = 'en') {
  await page.goto('/');
  await expect(page.getByTestId('driver-select')).toBeVisible();
  await page.getByTestId(`lang-${lang}`).click();
}

async function loadSample(page: Page, index: number) {
  await page.getByTestId(`sample-${index}`).click();
  await expect(page.getByTestId('generate')).toBeEnabled();
}

async function triangles(page: Page): Promise<number> {
  return Number(await page.getByTestId('mesh-stats').getAttribute('data-triangles'));
}

/** Generate and wait for a mesh with triangles. Returns the triangle count. */
async function generate(page: Page, timeout = 60_000): Promise<number> {
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', /^[1-9]\d*$/, { timeout });
  await expect(page.getByTestId('generate')).toBeVisible();
  await expect(page.getByTestId('error')).toHaveCount(0);
  return triangles(page);
}

/**
 * Renders the viewer twice (model shown / hidden) through the dev-only
 * `window.__3dmarkerViewer` handle and compares the frames: the changed
 * pixels are the model (plus its shadow). Reports coverage, bounds and
 * colour statistics so tests can assert the model is visible, framed, lit
 * and textured.
 */
async function renderStats(page: Page) {
  // Let the camera fit / damping settle first.
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    type Viewer = {
      renderer: { domElement: HTMLCanvasElement; render(s: unknown, c: unknown): void };
      scene: unknown;
      camera: unknown;
      object: { visible: boolean } | null;
    };
    const v = (window as unknown as { __3dmarkerViewer?: Viewer }).__3dmarkerViewer;
    if (!v || !v.object) throw new Error('viewer handle or model missing');
    const src = v.renderer.domElement;
    const w = src.width, h = src.height;
    const grab = () => {
      v.renderer.render(v.scene, v.camera);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(src, 0, 0); // same task as render(), so the drawing buffer is still intact
      return ctx.getImageData(0, 0, w, h).data;
    };
    const shown = grab();
    v.object.visible = false;
    const hidden = grab();
    v.object.visible = true;
    v.renderer.render(v.scene, v.camera);

    let count = 0, minX = w, minY = h, maxX = -1, maxY = -1;
    let sumL = 0, sumL2 = 0, sumSat = 0;
    const hues = new Set<number>();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(shown[i] - hidden[i]) + Math.abs(shown[i + 1] - hidden[i + 1]) + Math.abs(shown[i + 2] - hidden[i + 2]);
        if (d < 40) continue;
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const r = shown[i], g = shown[i + 1], b = shown[i + 2];
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        const l = (r + g + b) / 3;
        sumL += l;
        sumL2 += l * l;
        sumSat += mx === 0 ? 0 : (mx - mn) / mx;
        if (mx - mn > 40) {
          // Coarse hue bucket (12 bins) of saturated pixels.
          const hue = mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
          hues.add(Math.floor(hue * 2));
        }
      }
    }
    const mean = count ? sumL / count : 0;
    return {
      width: w,
      height: h,
      coverage: count / (w * h),
      bounds: { minX, minY, maxX, maxY },
      meanLuma: mean,
      lumaStd: count ? Math.sqrt(Math.max(0, sumL2 / count - mean * mean)) : 0,
      meanSaturation: count ? sumSat / count : 0,
      hueBins: hues.size,
    };
  });
}

type RenderStats = Awaited<ReturnType<typeof renderStats>>;

/** The model is visible, fully inside the viewport, shaded and not a flat grey blob. */
function expectSensibleRender(s: RenderStats, opts: { minCoverage?: number; minHues?: number } = {}) {
  expect(s.coverage, 'model covers a reasonable part of the viewer').toBeGreaterThan(opts.minCoverage ?? 0.04);
  expect(s.coverage, 'model is not zoomed in past the viewport').toBeLessThan(0.85);
  const margin = 2;
  expect(s.bounds.minX, 'framed (left)').toBeGreaterThan(margin);
  expect(s.bounds.minY, 'framed (top)').toBeGreaterThan(margin);
  expect(s.bounds.maxX, 'framed (right)').toBeLessThan(s.width - 1 - margin);
  expect(s.bounds.maxY, 'framed (bottom)').toBeLessThan(s.height - 1 - margin);
  expect(s.meanLuma, 'lit (not black)').toBeGreaterThan(35);
  expect(s.meanLuma, 'not blown out').toBeLessThan(245);
  expect(s.lumaStd, 'shaded (lighting varies over the surface)').toBeGreaterThan(8);
  expect(s.hueBins, 'textured (image colours visible)').toBeGreaterThanOrEqual(opts.minHues ?? 1);
}

test.describe('studio', () => {
  test('loads, lists every driver and logs no console errors', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await expect(page.getByTestId('driver-select')).toBeVisible();
    const values = await page.getByTestId('driver-select').locator('option').evaluateAll((opts) => opts.map((o) => (o as HTMLOptionElement).value));
    expect(values.sort()).toEqual(DRIVERS.map((d) => d.id).sort());
    expect(values.length).toBeGreaterThanOrEqual(7);
    await expect(page.getByTestId('generate')).toBeDisabled(); // no image yet
    await expect(page.getByTestId('driver-table')).toBeVisible();
    await page.waitForTimeout(500);
    expect(errors).toEqual([]);
  });

  for (const c of OFFLINE_CASES) {
    test(`offline driver ${c.driver} generates a rendered mesh`, async ({ page }) => {
      const errors = collectErrors(page);
      await open(page);
      await loadSample(page, c.sample);
      await page.getByTestId('driver-select').selectOption(c.driver);
      const tris = await generate(page);
      expect(tris).toBeGreaterThan(100);
      const s = await renderStats(page);
      console.log(`${c.driver}: ${tris} triangles, render`, JSON.stringify(s));
      expectSensibleRender(s, { minHues: c.driver === 'silhouette-inflate' ? 2 : 3 });
      await page.screenshot({ path: `${SHOTS}/${c.driver}.png` });
      // Clay + wireframe display modes render too.
      await page.getByTestId('view-clay').click();
      await page.getByTestId('view-wireframe').click();
      await page.waitForTimeout(300);
      await page.getByTestId('viewer').screenshot({ path: `${SHOTS}/${c.driver}-clay-wire.png` });
      expect(errors).toEqual([]);
    });
  }

  test('mesh sliders re-mesh live without re-running the driver', async ({ page }) => {
    await open(page);
    await loadSample(page, SAMPLE.mascot);
    await page.getByTestId('driver-select').selectOption('silhouette-inflate');
    const first = await generate(page);
    const elapsed = await page.getByTestId('mesh-stats').textContent();
    // Watch for any progress bar appearing from now on.
    await page.evaluate(() => {
      const w = window as unknown as { __progressSeen?: boolean };
      w.__progressSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-testid="progress"], [data-testid="viewer-progress"]')) w.__progressSeen = true;
      }).observe(document.body, { childList: true, subtree: true });
    });
    const zExtent = () =>
      page.evaluate(() => {
        type G = { boundingBox: { min: { z: number }; max: { z: number } } | null; computeBoundingBox(): void };
        const v = (window as unknown as { __3dmarkerViewer?: { object: { traverse(f: (o: { geometry?: G }) => void): void } | null } }).__3dmarkerViewer;
        let ext = 0;
        v?.object?.traverse((o) => {
          if (!o.geometry) return;
          o.geometry.computeBoundingBox();
          const b = o.geometry.boundingBox!;
          ext = Math.max(ext, b.max.z - b.min.z);
        });
        return ext;
      });

    const mesh = page.getByTestId('mesh-section');
    // Resolution: fewer grid cells → fewer triangles.
    const res = mesh.getByTestId('param-resolution').locator('input[type=number]');
    await res.fill('96');
    await res.press('Enter');
    await expect.poll(() => triangles(page)).toBeLessThan(first / 2);
    const lowRes = await triangles(page);

    // Depth: same topology, thicker model.
    const z0 = await zExtent();
    const depth = mesh.getByTestId('param-depthScale').locator('input[type=number]');
    await depth.fill('0.8');
    await depth.press('Enter');
    await expect.poll(zExtent).toBeGreaterThan(z0 * 1.3);
    expect(await triangles(page)).toBe(lowRes);

    expect(await page.evaluate(() => (window as unknown as { __progressSeen?: boolean }).__progressSeen)).toBe(false);
    // Same result (driver + elapsed time) → the driver did not run again.
    expect(await page.getByTestId('mesh-stats').textContent()).not.toBe('');
    expect((await page.getByTestId('mesh-stats').textContent())?.split('·').pop()).toBe(elapsed?.split('·').pop());
    await page.screenshot({ path: `${SHOTS}/remesh-inflate.png` });
  });

  test("mesh mode 'solid' is watertight, 'relief' is open", async ({ page }) => {
    await open(page);
    await loadSample(page, SAMPLE.landscape);
    await page.getByTestId('driver-select').selectOption('luminance-heightmap');
    await generate(page);
    const mode = page.getByTestId('mesh-section').getByTestId('param-mode').locator('select');
    await mode.selectOption('relief');
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'false');
    await mode.selectOption('solid');
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
    await page.getByTestId('view-reset').click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${SHOTS}/luminance-solid.png` });
    await mode.selectOption('double');
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
  });

  test('exports GLB, STL, OBJ and PLY downloads', async ({ page }) => {
    await open(page);
    await loadSample(page, SAMPLE.mascot);
    await page.getByTestId('driver-select').selectOption('silhouette-inflate');
    const tris = await generate(page);

    const download = async (format: string) => {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId(`export-${format}`).click()]);
      expect(dl.suggestedFilename()).toBe(`sample-mascot-silhouette-inflate.${format}`);
      const path = await dl.path();
      return readFile(path);
    };

    const glb = await download('glb');
    expect(glb.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    expect(json.meshes.length).toBeGreaterThan(0);
    expect(json.images?.length, 'GLB carries the texture').toBeGreaterThan(0);
    expect(glb.length).toBeGreaterThan(50_000);

    const stl = await download('stl');
    const n = stl.readUInt32LE(80);
    expect(n).toBe(tris);
    expect(stl.length).toBe(84 + 50 * n);

    const obj = (await download('obj')).toString('utf8');
    expect(obj.match(/^f /gm)?.length).toBe(tris);

    const ply = await download('ply');
    expect(ply.subarray(0, 3).toString()).toBe('ply');
    expect(ply.toString('latin1', 0, 400)).toContain(`element face ${tris}`);
  });

  test('ML driver fails fast with an error when Hugging Face is unreachable', async ({ page, context }) => {
    // Model weights / ONNX runtime cannot be downloaded (also true for this sandbox): fail deterministically.
    await context.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net/, (r) => r.abort('internetdisconnected'));
    await open(page);
    await loadSample(page, SAMPLE.landscape);
    await page.getByTestId('driver-select').selectOption('depth-anything-v2-small');
    await expect(page.getByTestId('driver-availability')).toBeVisible();
    await page.getByTestId('generate').click();
    const alert = page.getByTestId('error');
    await expect(alert).toBeVisible({ timeout: 45_000 });
    await expect(alert).toContainText(/Hugging Face/);
    await expect(page.getByTestId('generate')).toBeEnabled(); // not stuck in the running state
    await page.screenshot({ path: `${SHOTS}/ml-offline-error.png` });
  });

  test('Tripo driver without a server key explains that a key is needed', async ({ page }) => {
    await open(page);
    await loadSample(page, SAMPLE.mascot);
    await page.getByTestId('driver-select').selectOption('tripo3d-cloud');
    const availability = page.getByTestId('driver-availability');
    await expect(availability).toContainText(/own API key/);
    // The real API server (no TRIPO_API_KEY) answers 401 → localized "needs key" error.
    await page.getByTestId('generate').click();
    await expect(page.getByTestId('error')).toContainText(/No Tripo3D key is configured/, { timeout: 20_000 });
    await page.getByTestId('lang-tr').click();
    await expect(page.getByTestId('error')).toContainText(/kendi API anahtarınızı/);
    await page.screenshot({ path: `${SHOTS}/tripo-no-key.png` });
  });

  test('Tripo happy path (mocked API) loads the returned GLB', async ({ page }) => {
    const glb = buildCubeGlb();
    let polls = 0;
    let created: { method: string; key?: string; contentType?: string } | null = null;
    await page.route('**/api/tripo/status', (r) => r.fulfill({ json: { configured: false } }));
    await page.route('**/api/tripo/tasks', (r) => {
      const headers = r.request().headers();
      created = { method: r.request().method(), key: headers['x-tripo-key'], contentType: headers['content-type'] };
      return r.fulfill({ json: { taskId: 'task-e2e-1' } });
    });
    await page.route('**/api/tripo/tasks/task-e2e-1', (r) =>
      r.fulfill({ json: ++polls < 2 ? { status: 'running', progress: 40 } : { status: 'success', progress: 100 } }),
    );
    await page.route('**/api/tripo/tasks/task-e2e-1/model', (r) =>
      r.fulfill({ body: Buffer.from(glb), headers: { 'content-type': 'model/gltf-binary', 'content-length': String(glb.byteLength) } }),
    );

    await open(page);
    await loadSample(page, SAMPLE.mascot);
    await page.getByTestId('driver-select').selectOption('tripo3d-cloud');
    await expect(page.getByTestId('driver-availability')).toContainText(/own API key/);
    await page.getByTestId('params-section').getByTestId('param-apiKey').locator('input').fill('tsk_e2e_test_key');
    await page.getByTestId('generate').click();
    await expect(page.getByTestId('progress')).toBeVisible();
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', '12', { timeout: 30_000 });
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
    expect(created).toMatchObject({ method: 'POST', key: 'tsk_e2e_test_key', contentType: expect.stringMatching(/^multipart\/form-data/) });
    expect(polls).toBeGreaterThanOrEqual(2);
    const s = await renderStats(page);
    expectSensibleRender(s, { minCoverage: 0.02, minHues: 3 });
    await page.screenshot({ path: `${SHOTS}/tripo-mocked-cube.png` });
    // The secret key is never persisted.
    const stored = await page.evaluate(() => JSON.stringify(Object.entries(localStorage)));
    expect(stored).not.toContain('tsk_e2e_test_key');
  });

  test('language toggle switches visible text TR ↔ EN', async ({ page }) => {
    await open(page, 'en');
    await expect(page.getByTestId('generate')).toContainText('Generate 3D');
    await expect(page.locator('#driver-title')).toContainText('Driver');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByTestId('lang-tr').click();
    await expect(page.getByTestId('generate')).toContainText('3D Oluştur');
    await expect(page.locator('#driver-title')).toContainText('Sürücü');
    await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
    const option = page.getByTestId('driver-select').locator('option[value="silhouette-inflate"]');
    const trName = await option.textContent();
    await page.getByTestId('lang-en').click();
    await expect(page.getByTestId('generate')).toContainText('Generate 3D');
    expect(await option.textContent()).not.toBe(trName);
    // The choice survives a reload.
    await page.getByTestId('lang-tr').click();
    await page.reload();
    await expect(page.getByTestId('generate')).toContainText('3D Oluştur');
  });
});
