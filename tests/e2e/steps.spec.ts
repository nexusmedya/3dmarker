/**
 * End-to-end tests of the studio's step navigator and the flows it hosts:
 * keyboard navigation and persistence, AI preparation and view generation
 * with a (mocked) OpenAI provider, multi-view fusion with vertex colours,
 * sculpting / depth editing / rigging with animated GLB export.
 * Model downloads (Hugging Face, MediaPipe) are cut off: everything here
 * runs offline, the AI provider answers from a route mock.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SHOTS = 'test-results/screenshots';
const MASCOT = 1;

type StepId = 'image' | 'prep' | 'views' | '3d' | 'edit' | 'rig';

async function step(page: Page, id: StepId) {
  await page.getByTestId(`step-${id}`).click();
  await expect(page.getByTestId(`step-${id}`)).toHaveAttribute('aria-selected', 'true');
}

async function offline(context: BrowserContext) {
  await context.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net|storage\.googleapis\.com/, (r) => r.abort('internetdisconnected'));
}

async function openWithMascot(page: Page) {
  await page.goto('/');
  await page.getByTestId('lang-en').click();
  await page.getByTestId(`sample-${MASCOT}`).click();
  await expect(page.getByTestId('generate')).toBeEnabled();
}

async function generateInflate(page: Page): Promise<number> {
  await step(page, '3d');
  await page.getByTestId('driver-select').selectOption('silhouette-inflate');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', /^[1-9]\d*$/, { timeout: 60_000 });
  return Number(await page.getByTestId('mesh-stats').getAttribute('data-triangles'));
}

test.describe('step navigator', () => {
  test('tabs are keyboard accessible, show completion and the active step survives a reload', async ({ page, context }) => {
    await offline(context);
    await page.goto('/');
    await page.getByTestId('lang-en').click();
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(6);
    await expect(page.getByTestId('step-image')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('step-image')).toHaveAttribute('data-done', 'false');

    await page.getByTestId('step-image').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('step-prep')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('step-prep')).toBeFocused();
    await expect(page.locator('#step-panel-prep')).toBeVisible();
    await expect(page.locator('#step-panel-image')).toBeHidden();
    await page.keyboard.press('End');
    await expect(page.getByTestId('step-rig')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('ArrowRight'); // wraps
    await expect(page.getByTestId('step-image')).toHaveAttribute('aria-selected', 'true');

    await page.getByTestId(`sample-${MASCOT}`).click();
    await expect(page.getByTestId('step-image')).toHaveAttribute('data-done', 'true');
    // Next / Back buttons move between steps; Generate stays reachable and names the driver.
    await page.getByTestId('step-next-image').click();
    await expect(page.getByTestId('step-prep')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('generate-driver')).toContainText('Driver:');
    await step(page, 'views');
    await page.reload();
    await expect(page.getByTestId('step-views')).toHaveAttribute('aria-selected', 'true');
  });

  test('multi-view drivers need an extra view; Generate says so and links to the views step', async ({ page, context }) => {
    await offline(context);
    await openWithMascot(page);
    await step(page, '3d');
    await page.getByTestId('driver-select').selectOption('multiview-fusion');
    await expect(page.getByTestId('generate')).toBeDisabled();
    await expect(page.getByTestId('generate-blocked')).toContainText(/at least one more view/);
    await step(page, 'image');
    await page.getByTestId('generate-blocked-action').click();
    await expect(page.getByTestId('step-views')).toHaveAttribute('aria-selected', 'true');
    // An uploaded view unblocks it.
    const png = await page.evaluate(async () => {
      const c = new OffscreenCanvas(128, 160);
      const g = c.getContext('2d')!;
      g.fillStyle = '#2bb5a0';
      g.beginPath();
      g.ellipse(64, 84, 40, 60, 0, 0, Math.PI * 2);
      g.fill();
      return Array.from(new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer()));
    });
    await page.getByTestId('view-back').locator('input[type=file]').setInputFiles({ name: 'back.png', mimeType: 'image/png', buffer: Buffer.from(png) });
    await expect(page.getByTestId('view-back')).toHaveAttribute('data-filled', 'true');
    await expect(page.getByTestId('generate')).toBeEnabled();
    await expect(page.getByTestId('step-views')).toContainText('1/5');
  });
});

test.describe('AI provider flows (mocked OpenAI)', () => {
  test('prepare → accept → generate the missing views → multi-view fusion; keys stay out of localStorage', async ({ page, context }) => {
    await offline(context);
    await context.addInitScript(() => {
      if (sessionStorage.getItem('seeded')) return;
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem(
        '3dmarker:ai-settings',
        JSON.stringify({ version: 1, providers: [{ id: 'p1', kind: 'openai', label: 'OpenAI test', values: {}, models: {}, enabled: true }], defaults: {}, rememberKeys: false }),
      );
      sessionStorage.setItem('3dmarker:ai-keys', JSON.stringify({ p1: { apiKey: 'sk-e2e-test' } }));
    });
    await openWithMascot(page);
    await expect(page.getByTestId('ai-settings-count')).toHaveText('1');

    // The provider returns a transparent PNG (drawn in the page).
    const png = await page.evaluate(async () => {
      const c = new OffscreenCanvas(256, 320);
      const g = c.getContext('2d')!;
      g.fillStyle = '#e0457b';
      g.beginPath();
      g.ellipse(128, 170, 80, 120, 0, 0, Math.PI * 2);
      g.fill();
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = '';
      for (const b of bytes) s += String.fromCharCode(b);
      return btoa(s);
    });
    const calls: { url: string; auth?: string }[] = [];
    await context.route(/api\.openai\.com/, async (r) => {
      calls.push({ url: r.request().url(), auth: r.request().headers()['authorization'] });
      return r.fulfill({ json: { data: [{ b64_json: png }] }, headers: { 'access-control-allow-origin': '*' } });
    });

    await step(page, 'prep');
    await page.getByTestId('ai-prep-subject').selectOption('object');
    await page.getByTestId('style-picker').locator('[data-testid="style-photoreal"]').click();
    await page.getByTestId('ai-prep-run').click();
    await expect(page.getByTestId('ai-prep-result')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('ai-prep-accept').click();
    await expect(page.locator('#step-panel-prep [data-testid="revert-original"]')).toBeVisible();
    await expect(page.getByTestId('step-prep')).toHaveAttribute('data-done', 'true');
    expect(calls[0]).toMatchObject({ url: 'https://api.openai.com/v1/images/edits', auth: 'Bearer sk-e2e-test' });

    await step(page, 'views');
    await page.getByTestId('views-generate-missing').click();
    await expect(page.getByTestId('views-count')).toContainText('6/6', { timeout: 60_000 });
    expect(calls).toHaveLength(6);
    await expect(page.getByTestId('step-views')).toHaveAttribute('data-done', 'true');

    await step(page, '3d');
    await page.getByTestId('driver-select').selectOption('multiview-fusion');
    await page.getByTestId('params-section').getByTestId('param-depthRefine').locator('input').uncheck({ force: true });
    await page.getByTestId('generate').click();
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true', { timeout: 90_000 });
    const material = await page.evaluate(() => {
      type O = { isMesh?: boolean; geometry: { getAttribute(n: string): unknown }; material: { vertexColors: boolean; map: unknown } };
      const v = (window as unknown as { __3dmarkerViewer?: { getExportObject(): { traverse(f: (o: O) => void): void } | null } }).__3dmarkerViewer!;
      let info: { vertexColors: boolean; color: boolean; map: boolean } | null = null;
      v.getExportObject()!.traverse((o) => {
        if (o.isMesh && !info) info = { vertexColors: o.material.vertexColors, color: !!o.geometry.getAttribute('color'), map: !!o.material.map };
      });
      return info;
    });
    expect(material).toEqual({ vertexColors: true, color: true, map: false });
    await page.screenshot({ path: `${SHOTS}/steps-multiview-fusion.png` });

    // Revert keeps the views; the key never reached localStorage.
    await step(page, 'image');
    await page.locator('#step-panel-image [data-testid="revert-original"]').click();
    await expect(page.locator('#step-panel-image [data-testid="revert-original"]')).toHaveCount(0);
    await expect(page.getByTestId('step-views')).toContainText('5/5');
    expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain('sk-e2e-test');
  });
});

test.describe('edit and rig', () => {
  test('sculpt edits pause live re-meshing until discarded; the depth editor rebuilds the model', async ({ page, context }) => {
    await offline(context);
    await openWithMascot(page);
    const tris = await generateInflate(page);

    await step(page, 'edit');
    await page.getByTestId('sculpt-toggle').click();
    await expect(page.getByTestId('sculpt-panel')).toHaveAttribute('data-active', 'true');
    const box = (await page.getByTestId('viewer').boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx - 60, cy);
    await page.mouse.down();
    for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy + (i % 2) * 4);
    await page.mouse.up();
    await expect(page.getByTestId('step-edit')).toHaveAttribute('data-done', 'true');

    await step(page, '3d');
    await expect(page.getByTestId('mesh-paused')).toBeVisible();
    const res = page.getByTestId('mesh-section').getByTestId('param-resolution').locator('input[type=number]');
    await res.fill('96');
    await res.press('Enter');
    await page.waitForTimeout(400); // longer than the re-mesh debounce
    expect(Number(await page.getByTestId('mesh-stats').getAttribute('data-triangles'))).toBe(tris);
    await page.getByTestId('discard-sculpt').click();
    await expect(page.getByTestId('mesh-paused')).toHaveCount(0);
    await expect.poll(async () => Number(await page.getByTestId('mesh-stats').getAttribute('data-triangles'))).toBeLessThan(tris / 2);
    await expect(page.getByTestId('step-edit')).toHaveAttribute('data-done', 'false');

    await step(page, 'edit');
    await page.getByTestId('depth-edit-open').click();
    await expect(page.getByTestId('depth-editor')).toBeVisible();
    const stage = (await page.getByTestId('depth-stage').boundingBox())!;
    await page.mouse.move(stage.x + stage.width / 2 - 30, stage.y + stage.height / 2);
    await page.mouse.down();
    for (let i = 0; i <= 8; i++) await page.mouse.move(stage.x + stage.width / 2 - 30 + i * 8, stage.y + stage.height / 2);
    await page.mouse.up();
    await page.getByTestId('depth-apply').click();
    await expect(page.getByTestId('depth-editor')).toHaveCount(0);
    // Still re-meshable after the edit.
    await step(page, '3d');
    const before = Number(await page.getByTestId('mesh-stats').getAttribute('data-triangles'));
    await res.fill('128');
    await res.press('Enter');
    await expect.poll(async () => Number(await page.getByTestId('mesh-stats').getAttribute('data-triangles'))).toBeGreaterThan(before);
  });

  test('rigging exports an animated GLB named “-rigged”, and pauses sculpting and re-meshing', async ({ page, context }) => {
    await offline(context);
    await openWithMascot(page);
    await generateInflate(page);
    await step(page, 'rig');
    await page.getByTestId('rig-auto').click();
    await expect(page.getByTestId('step-rig')).toHaveAttribute('data-done', 'true', { timeout: 60_000 });
    await expect(page.getByTestId('export-animations')).toContainText(/GLB includes \d+ animations/);
    await step(page, '3d');
    await expect(page.getByTestId('mesh-paused')).toContainText(/rigged/);
    await step(page, 'edit');
    await expect(page.getByTestId('sculpt-rigged')).toBeVisible();
    await expect(page.getByTestId('depth-edit-open')).toBeDisabled();

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-glb').click()]);
    expect(dl.suggestedFilename()).toBe('sample-mascot-silhouette-inflate-rigged.glb');
    const glb = await readFile(await dl.path());
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    expect(json.skins?.length).toBe(1);
    expect(json.animations?.length).toBeGreaterThanOrEqual(36);
  });
});
