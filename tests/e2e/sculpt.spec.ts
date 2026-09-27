/**
 * Edit step regressions: sculpting a coarse extrusion (the star logo's flat
 * caps have no inner vertex: the session subdivides it) and the depth map
 * editor asking before Esc / X / Cancel throw its edits away. Offline.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

/** Sample buttons (see src/app/samples.ts): 0 = star logo, 2 = landscape photo. */
const SAMPLE = { logo: 0, landscape: 2 } as const;

async function offline(context: BrowserContext) {
  await context.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net|storage\.googleapis\.com/, (r) => r.abort('internetdisconnected'));
}

async function step(page: Page, id: '3d' | 'edit') {
  await page.getByTestId(`step-${id}`).click();
  await expect(page.getByTestId(`step-${id}`)).toHaveAttribute('aria-selected', 'true');
}

async function generate(page: Page, sample: number, driver: string): Promise<number> {
  await page.goto('/');
  await page.getByTestId('lang-en').click();
  await page.getByTestId(`sample-${sample}`).click();
  await expect(page.getByTestId('generate')).toBeEnabled();
  await step(page, '3d');
  await page.getByTestId('driver-select').selectOption(driver);
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', /^[1-9]\d*$/, { timeout: 60_000 });
  return Number(await page.getByTestId('mesh-stats').getAttribute('data-triangles'));
}

test('sculpting works on the extruded star logo (coarse caps are subdivided)', async ({ page, context }) => {
  await offline(context);
  const tris = await generate(page, SAMPLE.logo, 'silhouette-extrude');
  await step(page, 'edit');
  await page.getByTestId('sculpt-toggle').click();
  await expect(page.getByTestId('sculpt-panel')).toHaveAttribute('data-active', 'true');
  await expect(page.getByTestId('sculpt-refined')).toBeVisible();
  await expect.poll(async () => Number(await page.getByTestId('mesh-stats').getAttribute('data-triangles'))).toBeGreaterThan(tris);
  const box = (await page.getByTestId('viewer').boundingBox())!;
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  for (const brush of ['draw', 'inflate', 'grab', 'crease']) {
    await page.getByTestId(`brush-${brush}`).click();
    await page.mouse.move(cx - 20, cy);
    await page.mouse.down();
    for (let i = 0; i <= 8; i++) await page.mouse.move(cx - 20 + i * 5, cy + (i % 2) * 3);
    await page.mouse.up();
  }
  await expect(page.getByTestId('sculpt-strokes')).toHaveAttribute('data-strokes', '4');
  await expect(page.getByTestId('sculpt-empty-stroke')).toHaveCount(0);
});

test('the depth map editor asks before discarding edits; Esc twice keeps them', async ({ page, context }) => {
  await offline(context);
  await generate(page, SAMPLE.landscape, 'luminance-heightmap');
  await step(page, 'edit');

  // Nothing edited: Esc closes at once.
  await page.getByTestId('depth-edit-open').click();
  await expect(page.getByTestId('depth-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('depth-editor')).toHaveCount(0);

  await page.getByTestId('depth-edit-open').click();
  const stage = (await page.getByTestId('depth-stage').boundingBox())!;
  const sx = stage.x + stage.width / 2, sy = stage.y + stage.height / 2;
  await page.mouse.move(sx - 30, sy);
  await page.mouse.down();
  for (let i = 0; i <= 8; i++) await page.mouse.move(sx - 30 + i * 8, sy);
  await page.mouse.up();
  await expect(page.getByTestId('depth-edits')).toHaveAttribute('data-edits', '1');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('depth-editor')).toBeVisible();
  await expect(page.getByTestId('depth-discard-confirm')).toContainText('Discard 1 edits?');
  await expect(page.getByTestId('depth-keep')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('depth-discard-confirm')).toHaveCount(0);
  await expect(page.getByTestId('depth-editor')).toBeVisible();
  await expect(page.getByTestId('depth-edits')).toHaveAttribute('data-edits', '1');

  await page.getByTestId('depth-cancel').click();
  await page.getByTestId('depth-keep').click();
  await expect(page.getByTestId('depth-edits')).toHaveAttribute('data-edits', '1');

  await page.getByTestId('depth-close').click();
  await page.getByTestId('depth-discard').click();
  await expect(page.getByTestId('depth-editor')).toHaveCount(0);
});
