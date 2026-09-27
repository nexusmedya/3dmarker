/**
 * End-to-end tests of multi-view fusion with hand-made views: the "T-pose
 * mannequin (hand-drawn views)" sample (src/app/samples.ts, index 4) whose
 * back / left / right views were drawn with their own scale, offset and arm
 * height, the left one cut off at the bottom border — the reported case in
 * which the arms vanished. Checks the consistency badges, the Align panel,
 * per-view trust, the copied prompt and the fused mesh's body proportions
 * against the consistent sample. Offline like features.spec.ts: the depth
 * model is unreachable, so the fusion runs on silhouettes alone.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SHOTS = 'test-results/screenshots';
/** Sample buttons (src/app/samples.ts): 3 = consistent T-pose mannequin, 4 = the same front with hand-drawn views. */
const SAMPLE = { tpose: 3, sketch: 4 } as const;
const SKETCH_VIEWS = ['back', 'left', 'right'] as const;

type StepId = 'image' | 'prep' | 'views' | '3d' | 'edit' | 'rig';

async function step(page: Page, id: StepId) {
  await page.getByTestId(`step-${id}`).click();
  await expect(page.getByTestId(`step-${id}`)).toHaveAttribute('aria-selected', 'true');
}

/** Model hosts unreachable: Hugging Face (depth models), jsDelivr, Google's MediaPipe bucket. */
async function offline(context: BrowserContext) {
  await context.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net|storage\.googleapis\.com/, (r) => r.abort('internetdisconnected'));
}

/** Console errors / uncaught exceptions, minus the network noise of the hosts cut off on purpose. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  return errors;
}

async function open(page: Page, lang: 'en' | 'tr' = 'en') {
  await page.goto('/');
  await expect(page.getByTestId('step-image')).toBeVisible();
  await page.getByTestId(`lang-${lang}`).click();
}

async function loadSample(page: Page, index: number) {
  await step(page, 'image');
  await page.getByTestId(`sample-${index}`).click();
  await expect(page.getByTestId('generate')).toBeEnabled();
}

/** Runs the driver and waits for the run to start and end (a model from an earlier run must not be measured). */
async function generate(page: Page, timeout = 90_000) {
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('cancel')).toBeVisible();
  await expect(page.getByTestId('generate')).toBeVisible({ timeout });
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', /^[1-9]\d*$/, { timeout });
  await expect(page.getByTestId('error')).toHaveCount(0);
}

/** Loads the sample and fuses it with the multi-view driver (silhouette hull: the depth model is offline). */
async function fuseSample(page: Page, index: number) {
  await loadSample(page, index);
  await step(page, '3d');
  await page.getByTestId('driver-select').selectOption('multiview-fusion');
  await generate(page);
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
}

/** The three sketch views are in their slots and their consistency checks have run. */
async function expectSketchViewsChecked(page: Page) {
  await step(page, 'views');
  for (const v of SKETCH_VIEWS) await expect(page.getByTestId(`view-${v}`)).toHaveAttribute('data-filled', 'true', { timeout: 15_000 });
  await expect(page.getByTestId('views-count')).toContainText('4/6');
  for (const v of SKETCH_VIEWS) await expect(page.getByTestId(`view-check-${v}`)).toHaveAttribute('data-level', /^(good|fair|poor)$/, { timeout: 15_000 });
}

interface BodyStats {
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  /** Vertices with |x| > 0.5 (the outer halves of the outstretched arms) over all vertices. */
  armShare: number;
  /** Half-width of the torso just below the arms: max |x| with |y − 0.28| < 0.06 and |x| < 0.45. */
  chestWidth: number;
  /** Half-width at the hips: max |x| with |y| < 0.05 and |x| < 0.45. */
  hipWidth: number;
  minY: number;
}

/**
 * Arm / torso metrics of the mesh on screen, in world space (the shared frame:
 * longest side 2, +Y up; the mannequin's arm span is its longest side). The
 * chest band sits below the sleeves (arms end at y ≈ 0.40 on the mannequin),
 * so it measures the torso itself; a bell-shaped torso shows as hips wider
 * than the chest, lost arms as a low armShare and a narrow sizeX / sizeY.
 */
async function bodyStats(page: Page): Promise<BodyStats> {
  return page.evaluate(() => {
    type Attr = { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number };
    type O = { isMesh?: boolean; geometry?: { getAttribute(n: string): Attr | undefined }; matrixWorld: { elements: ArrayLike<number> } };
    type Root = { traverse(f: (o: O) => void): void; updateMatrixWorld(force: boolean): void };
    const v = (window as unknown as { __3dmarkerViewer: { getObject(): Root | null } }).__3dmarkerViewer;
    const root = v.getObject();
    if (!root) throw new Error('no model on screen');
    root.updateMatrixWorld(true);
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    let all = 0, arm = 0, chest = 0, hip = 0;
    root.traverse((o) => {
      const p = o.isMesh ? o.geometry?.getAttribute('position') : undefined;
      if (!p) return;
      const e = o.matrixWorld.elements;
      for (let i = 0; i < p.count; i++) {
        const lx = p.getX(i), ly = p.getY(i), lz = p.getZ(i);
        const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12];
        const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13];
        const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14];
        min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
        max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
        all++;
        const ax = Math.abs(x);
        if (ax > 0.5) arm++;
        if (ax < 0.45 && Math.abs(y - 0.28) < 0.06) chest = Math.max(chest, ax);
        if (ax < 0.45 && Math.abs(y) < 0.05) hip = Math.max(hip, ax);
      }
    });
    if (!all) throw new Error('no vertices on screen');
    return { sizeX: max[0] - min[0], sizeY: max[1] - min[1], sizeZ: max[2] - min[2], armShare: arm / all, chestWidth: chest, hipWidth: hip, minY: min[1] };
  });
}

/**
 * Share of the hand vertices (|x| > 0.85 of the largest |x|) whose vertex colour is shirt blue (linear RGB
 * b > 0.3 and b > 2r): the side views see the arms end-on in front of the torso, and the hull's extra depth
 * there used to pick up the shirt behind them.
 */
async function handBlueShare(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Attr = { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number };
    type O = { isMesh?: boolean; geometry?: { getAttribute(n: string): Attr | undefined } };
    const v = (window as unknown as { __3dmarkerViewer: { getObject(): { traverse(f: (o: O) => void): void } | null } }).__3dmarkerViewer;
    const root = v.getObject();
    if (!root) throw new Error('no model on screen');
    let maxX = 0, hands = 0, blue = 0;
    const meshes: { p: Attr; c: Attr }[] = [];
    root.traverse((o) => {
      const p = o.isMesh ? o.geometry?.getAttribute('position') : undefined;
      const c = o.isMesh ? o.geometry?.getAttribute('color') : undefined;
      if (!p || !c) return;
      meshes.push({ p, c });
      for (let i = 0; i < p.count; i++) maxX = Math.max(maxX, Math.abs(p.getX(i)));
    });
    if (!meshes.length) throw new Error('no vertex colours on screen');
    for (const { p, c } of meshes)
      for (let i = 0; i < p.count; i++) {
        if (Math.abs(p.getX(i)) <= 0.85 * maxX) continue;
        hands++;
        const r = c.getX(i), b = c.getZ(i);
        if (b > 0.3 && b > 2 * r) blue++;
      }
    return blue / Math.max(1, hands);
  });
}

/** Sanity of a fused mannequin: arms out to the sides, a torso that is not bell-shaped. */
function expectMannequin(s: BodyStats, label: string) {
  expect(s.sizeX / s.sizeY, `${label}: arm span / height`).toBeGreaterThanOrEqual(0.85);
  expect(s.armShare, `${label}: arm share`).toBeGreaterThanOrEqual(0.05);
  expect(s.hipWidth / s.chestWidth, `${label}: hips / chest`).toBeGreaterThanOrEqual(0.6);
  expect(s.hipWidth / s.chestWidth, `${label}: hips / chest`).toBeLessThanOrEqual(1.4);
}

async function noHorizontalOverflow(page: Page, label: string) {
  const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(m.scroll, label).toBeLessThanOrEqual(m.client);
}

/** Opens the Align panel of `view` (or focuses it when already open). */
async function openAlign(page: Page, view: (typeof SKETCH_VIEWS)[number]) {
  const panel = page.getByTestId('view-align-panel');
  if ((await panel.count()) && (await panel.getAttribute('data-view')) === view) return panel;
  await page.getByTestId(`view-align-${view}`).click();
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-view', view);
  await expect(page.getByTestId(`view-align-${view}`)).toHaveAttribute('aria-expanded', 'true');
  return panel;
}

test.describe('fusion of hand-drawn views', () => {
  test.describe.configure({ mode: 'serial' });
  /** Body metrics of the consistent sample (test 1), the reference for the hand-drawn one. */
  let ref: BodyStats | null = null;

  test('consistent reference: the T-pose mannequin fuses with its arms and a straight torso', async ({ page, context }) => {
    await offline(context);
    const errors = collectErrors(page);
    await open(page);
    await fuseSample(page, SAMPLE.tpose);
    ref = await bodyStats(page);
    expectMannequin(ref, 'consistent');
    expect(await handBlueShare(page), 'shirt blue on the hands').toBeLessThan(0.05);
    await page.getByTestId('viewer').screenshot({ path: `${SHOTS}/fusion-consistent.png` });
    expect(errors).toEqual([]);
  });

  test('inconsistent views: badges, a detected crop, and a fused model with its arms intact', async ({ page, context }) => {
    test.setTimeout(180_000);
    await offline(context);
    const errors = collectErrors(page);
    await open(page);
    if (!ref) {
      // Run on its own: measure the reference first.
      await fuseSample(page, SAMPLE.tpose);
      ref = await bodyStats(page);
    }
    await loadSample(page, SAMPLE.sketch);
    await expect(page.locator('#step-panel-image')).toContainText('sample-tpose-sketch.png');
    await expectSketchViewsChecked(page);
    // needs Areas A+B: the left view's feet run past the bottom border.
    await expect(page.getByTestId('view-check-left')).toHaveAttribute('data-cut', /bottom/);
    for (const v of SKETCH_VIEWS) {
      const badge = page.getByTestId(`view-check-${v}`);
      await expect(badge).toHaveAttribute('data-score', /^\d+$/);
      await expect(badge).toHaveAttribute('aria-label', /Consistency \d+ %/);
    }
    await page.getByTestId('views-panel').screenshot({ path: `${SHOTS}/views-badges.png` });

    await step(page, '3d');
    await page.getByTestId('driver-select').selectOption('multiview-fusion');
    await generate(page);
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
    // needs Areas A+B: the report of the run.
    const report = page.getByTestId('fusion-report');
    await expect(report).toBeVisible();
    for (const v of SKETCH_VIEWS) await expect(report.getByTestId(`fusion-view-${v}`)).toHaveAttribute('data-score', /^\d+$/);
    await expect(report.getByTestId('fusion-view-left')).toHaveAttribute('data-trust', 'full');

    // needs Areas A+B: the arms survive, the torso keeps its proportions, the cropped feet are filled in.
    const s = await bodyStats(page);
    expectMannequin(s, 'hand-drawn');
    expect(await handBlueShare(page), 'shirt blue on the hands (hand-drawn views)').toBeLessThan(0.05);
    expect(Math.abs(s.hipWidth / s.chestWidth - ref.hipWidth / ref.chestWidth), 'hips / chest vs the consistent sample').toBeLessThanOrEqual(0.2);
    expect(Math.abs(s.sizeZ - ref.sizeZ), 'depth vs the consistent sample').toBeLessThanOrEqual(0.3 * ref.sizeZ);
    expect(Math.abs(s.minY - ref.minY), 'feet vs the consistent sample').toBeLessThanOrEqual(0.06);
    await page.getByTestId('viewer').screenshot({ path: `${SHOTS}/fusion-robust-arms.png` });

    // The same page at phone width: report and viewer fit without horizontal overflow.
    await page.setViewportSize({ width: 375, height: 812 });
    await expect(report).toBeVisible();
    await noHorizontalOverflow(page, '375 px, 3D step');
    await page.screenshot({ path: `${SHOTS}/fusion-robust-arms-phone.png` });
    await step(page, 'views');
    await noHorizontalOverflow(page, '375 px, views step');
    expect(errors).toEqual([]);
  });
});

test.describe('views step on phones', () => {
  for (const width of [375, 414]) {
    test(`${width} px: slot names are never cut, action buttons stay on one row, long buttons wrap inside their border`, async ({ page, context }) => {
      await offline(context);
      await page.setViewportSize({ width, height: 860 });
      await open(page, 'tr');
      await loadSample(page, SAMPLE.sketch);
      // A single-image driver: the views step then offers the long "Next: full 3D" button.
      await step(page, '3d');
      await page.getByTestId('driver-select').selectOption('silhouette-inflate');
      await expectSketchViewsChecked(page);
      for (const v of ['front', ...SKETCH_VIEWS, 'top', 'bottom']) {
        const slot = page.getByTestId(`view-${v}`);
        const name = await slot.locator('.ai-slot-name').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
        expect(name.scroll, `${v}: slot name`).toBeLessThanOrEqual(name.client);
        const tops = await slot.locator('.ai-slot-actions > button').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
        expect(new Set(tops).size, `${v}: action rows`).toBeLessThanOrEqual(1);
      }
      const next = page.getByTestId('views-use-fusion');
      await expect(next).toBeVisible();
      const b = await next.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
      expect(b.scroll, 'views-use-fusion label').toBeLessThanOrEqual(b.client);
      await noHorizontalOverflow(page, `${width} px, views step`);
      await page.getByTestId('views-panel').screenshot({ path: `${SHOTS}/views-${width}.png` });
    });
  }
});

test.describe('alignment controls', () => {
  test('the Align panel re-scores while editing, auto / reset restore the check, Esc returns focus; no X offset for a side view', async ({
    page,
    context,
  }) => {
    await offline(context);
    const errors = collectErrors(page);
    await open(page);
    await loadSample(page, SAMPLE.sketch);
    await expectSketchViewsChecked(page);

    const badge = page.getByTestId('view-check-back');
    const checked = (await badge.getAttribute('data-score'))!;
    const panel = await openAlign(page, 'back');
    const status = page.getByTestId('align-status');
    await expect(status).toContainText(/^\d+ · /);
    const before = (await status.textContent())!;
    await expect(page.getByTestId('align-dx')).toHaveCount(1); // the back shares both axes with the front

    // A manual vertical offset re-scores the view at once (no core re-run) — badge and status alike.
    await page.getByTestId('align-dy').fill('-6');
    await expect(page.getByTestId('align-dy')).toHaveValue('-6');
    await expect(status).not.toHaveText(before);
    await expect(badge).not.toHaveAttribute('data-score', checked);
    // The range slider reaches the paired number input and the score too (drags are coalesced per frame).
    const shifted = (await status.textContent())!;
    await page.getByTestId('align-scale-range').fill('110');
    await expect(page.getByTestId('align-scale')).toHaveValue('110');
    await expect(status).not.toHaveText(shifted);
    await expect(status).not.toHaveText(before);
    await panel.screenshot({ path: `${SHOTS}/align-panel.png` });

    // Auto-align goes back to the registration's own result, Reset to the defaults.
    await page.getByTestId('align-auto').click();
    await expect(badge).toHaveAttribute('data-score', checked);
    await expect(status).toHaveText(before);
    await page.getByTestId('align-dy').fill('4');
    await expect(badge).not.toHaveAttribute('data-score', checked);
    await page.getByTestId('align-reset').click();
    await expect(badge).toHaveAttribute('data-score', checked);
    await expect(page.getByTestId('align-flip')).not.toBeChecked();

    // Escape closes the panel and hands focus back to the button that opened it.
    await panel.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId('view-align-back')).toBeFocused();
    await expect(page.getByTestId('view-align-back')).toHaveAttribute('aria-expanded', 'false');

    // A side view shares only the vertical axis: no X offset slider.
    await openAlign(page, 'left');
    await expect(page.getByTestId('align-dx')).toHaveCount(0);
    await expect(page.getByTestId('align-dy')).toHaveCount(1);
    await expect(page.getByTestId('align-scale')).toHaveCount(1);
    await expect(page.getByTestId('align-overlay')).toBeVisible();
    await page.getByTestId('align-close').click();
    await expect(page.getByTestId('view-align-panel')).toHaveCount(0);

    // The guidance on consistent views is there in both languages.
    const guide = page.getByTestId('views-guide');
    await expect(guide).toContainText('Making views consistent');
    await page.getByTestId('lang-tr').click();
    await expect(guide).toContainText('Görünümleri tutarlı yapmak için');
    expect(errors).toEqual([]);
  });
});

test.describe('per-view trust', () => {
  test('colour-only keeps a view out of the shape; all views off blocks Generate until one is back', async ({ page, context }) => {
    test.setTimeout(150_000);
    await offline(context);
    const errors = collectErrors(page);
    await open(page);
    await loadSample(page, SAMPLE.sketch);
    await step(page, '3d');
    await page.getByTestId('driver-select').selectOption('multiview-fusion');
    await expectSketchViewsChecked(page);

    await openAlign(page, 'left');
    await page.getByTestId('align-trust-color').check({ force: true });
    await expect(page.getByTestId('align-trust-color')).toBeChecked();
    await expect(page.getByTestId('view-left')).toHaveAttribute('data-trust', 'color');
    await expect(page.getByTestId('view-trust-left')).toHaveText(/Colour only/);
    await expect(page.getByTestId('view-check-left')).toBeVisible(); // still checked (only 'off' hides the badge)
    await page.getByTestId('align-close').click();

    await generate(page);
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
    await step(page, '3d');
    // needs Areas A+B: the report carries the effective trust.
    const chip = page.getByTestId('fusion-report').getByTestId('fusion-view-left');
    await expect(chip).toHaveAttribute('data-trust', 'color');
    await expect(chip).toContainText(/colour only/i);
    await expect(page.getByTestId('fusion-report').getByTestId('fusion-view-back')).toHaveAttribute('data-trust', 'full');
    const s = await bodyStats(page);
    expect(s.armShare, 'arm share with a colour-only side').toBeGreaterThanOrEqual(0.05);
    await page.getByTestId('fusion-report').screenshot({ path: `${SHOTS}/fusion-report-colour-only.png` });

    // Every extra view off: nothing left for the multi-view driver to fuse.
    await step(page, 'views');
    for (const v of SKETCH_VIEWS) {
      await openAlign(page, v);
      await page.getByTestId('align-trust-off').check({ force: true });
      await expect(page.getByTestId(`view-${v}`)).toHaveAttribute('data-trust', 'off');
      await expect(page.getByTestId(`view-trust-${v}`)).toHaveText(/Off/);
      await page.getByTestId('align-close').click();
    }
    await expect(page.getByTestId('generate')).toBeDisabled();
    await expect(page.getByTestId('generate-blocked')).toContainText(/view/i);
    await page.getByTestId('views-panel').screenshot({ path: `${SHOTS}/views-all-off.png` });

    await openAlign(page, 'back');
    await page.getByTestId('align-trust-full').check({ force: true });
    await expect(page.getByTestId('view-back')).toHaveAttribute('data-trust', 'full');
    await expect(page.getByTestId('view-trust-back')).toHaveCount(0);
    await expect(page.getByTestId('generate')).toBeEnabled();
    await expect(page.getByTestId('generate-blocked')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('copy prompt', () => {
  test('copies an English prompt with the front’s framing, announces it in both languages, and falls back to a text box', async ({
    page,
    context,
  }) => {
    await offline(context);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const errors = collectErrors(page);
    await open(page);
    await loadSample(page, SAMPLE.sketch);
    await step(page, 'views');
    await expect(page.getByTestId('view-top')).toHaveAttribute('data-filled', 'false');

    await page.getByTestId('view-prompt-top').click();
    await expect(page.getByTestId('views-hint')).toContainText(/copied/i);
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain('Attached is the FRONT view');
    expect(text).toContain('the TOP view');
    expect(text).toContain('Output size 768 × 768 px');
    expect(text).toContain('% of the image height');
    expect(text).toMatch(/orthographic/);
    expect(text).not.toMatch(/[çğıöşü]/i); // English only
    await expect(page.getByTestId('view-prompt-text')).toHaveCount(0);

    // Turkish UI: the notice is Turkish, the prompt stays English.
    await page.getByTestId('lang-tr').click();
    await page.getByTestId('view-prompt-back').click();
    await expect(page.getByTestId('views-hint')).toContainText(/kopyalandı/);
    const back = await page.evaluate(() => navigator.clipboard.readText());
    expect(back).toContain('the BACK view');
    expect(back).toContain('Output size 768 × 768 px');
    await page.getByTestId('lang-en').click();
    expect(errors).toEqual([]);

    // Clipboard refused: the prompt appears in a read-only text box instead.
    await context.addInitScript(() => {
      Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: () => Promise.reject(new Error('denied')) });
    });
    const other = await context.newPage();
    const otherErrors = collectErrors(other);
    await open(other);
    await loadSample(other, SAMPLE.sketch);
    await step(other, 'views');
    await other.getByTestId('view-prompt-top').click();
    await expect(other.getByTestId('views-hint')).toContainText(/clipboard/i);
    const box = other.getByTestId('view-prompt-text');
    await expect(box).toBeVisible();
    await expect(box).toHaveValue(text);
    await other.getByTestId('view-prompt-select').click();
    expect(await box.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart)).toBe(text.length);
    await other.getByTestId('views-panel').screenshot({ path: `${SHOTS}/views-prompt-fallback.png` });
    expect(otherErrors).toEqual([]);
    await other.close();
  });
});
