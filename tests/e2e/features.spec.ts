/**
 * End-to-end tests of the AI / multi-view / human-detail / sculpt / rig
 * features in a real browser. External services are mocked or cut off:
 * OpenAI answers from route mocks (images drawn by tests/e2e/png.ts,
 * a different character view per prompt), Hugging Face and the MediaPipe
 * model bucket are unreachable (fusion falls back to the silhouette hull,
 * human detection reports "unavailable"), so everything runs offline.
 */
import { readFile } from 'node:fs/promises';
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import { characterView, type RGBA } from './png';

const SHOTS = 'test-results/screenshots';
/** Sample buttons (src/app/samples.ts): 0 logo, 1 mascot, 2 landscape, 3 T-pose mannequin (+ back / left / right views). */
const SAMPLE = { mascot: 1, landscape: 2, tpose: 3 } as const;
const CORS = { 'access-control-allow-origin': '*' };

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

async function generate(page: Page, timeout = 90_000) {
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('generate')).toBeVisible({ timeout });
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', /^[1-9]\d*$/, { timeout });
  await expect(page.getByTestId('error')).toHaveCount(0);
}

/** A value of multipart form field `name` (the OpenAI edit request's prompt). */
function formField(req: Request, name: string): string {
  const body = req.postDataBuffer()?.toString('latin1') ?? '';
  const m = new RegExp(`name="${name}"\\r\\n(?:[^\\r\\n]+\\r\\n)*\\r\\n([\\s\\S]*?)\\r\\n--`).exec(body);
  return m ? Buffer.from(m[1], 'latin1').toString('utf8') : '';
}

/** Which view an OpenAI edit request asks for (src/ai/prompts.ts wording), 'front' for the preparation. */
function viewOfPrompt(prompt: string): 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' {
  if (/the BACK view/.test(prompt)) return 'back';
  if (/the LEFT side view/.test(prompt)) return 'left';
  if (/the RIGHT side view/.test(prompt)) return 'right';
  if (/the TOP view/.test(prompt)) return 'top';
  if (/the BOTTOM view/.test(prompt)) return 'bottom';
  return 'front';
}

const SHIRTS: Record<string, RGBA> = {
  front: [220, 38, 38, 255],
  back: [22, 163, 74, 255],
  left: [37, 99, 235, 255],
  right: [234, 179, 8, 255],
  top: [147, 51, 234, 255],
  bottom: [236, 72, 153, 255],
};

interface EditCall {
  view: string;
  prompt: string;
  auth?: string;
  images: number;
}

/** Mocked OpenAI: /v1/models for the connection test, /v1/images/edits drawing the requested view. */
async function mockOpenAi(context: BrowserContext): Promise<{ edits: EditCall[]; models: (string | undefined)[] }> {
  const edits: EditCall[] = [];
  const models: (string | undefined)[] = [];
  await context.route('https://api.openai.com/**', async (r) => {
    const req = r.request();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } });
    const url = new URL(req.url());
    if (url.pathname === '/v1/models') {
      models.push(req.headers()['authorization']);
      return r.fulfill({ json: { object: 'list', data: [{ id: 'gpt-image-1', object: 'model' }] }, headers: CORS });
    }
    if (url.pathname === '/v1/images/edits') {
      const prompt = formField(req, 'prompt');
      const view = viewOfPrompt(prompt);
      const raw = req.postDataBuffer()?.toString('latin1') ?? '';
      edits.push({ view, prompt, auth: req.headers()['authorization'], images: (raw.match(/name="image(\[\])?"/g) ?? []).length });
      const png = characterView(view, SHIRTS[view]);
      return r.fulfill({ json: { created: 0, data: [{ b64_json: png.toString('base64') }] }, headers: CORS });
    }
    return r.fulfill({ status: 404, json: { error: { message: 'not mocked' } }, headers: CORS });
  });
  return { edits, models };
}

/** Seeds one OpenAI provider (key in session storage, as the app stores it without "remember"). */
async function seedOpenAi(context: BrowserContext, key = 'sk-e2e-features') {
  await context.addInitScript((k) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem(
      '3dmarker:ai-settings',
      JSON.stringify({ version: 1, providers: [{ id: 'p1', kind: 'openai', label: 'OpenAI e2e', values: {}, models: {}, enabled: true }], defaults: {}, rememberKeys: false }),
    );
    sessionStorage.setItem('3dmarker:ai-keys', JSON.stringify({ p1: { apiKey: k } }));
  }, key);
}

/** Checksum of every mesh position on screen (changes when the surface is edited). */
async function positionChecksum(page: Page): Promise<number> {
  return page.evaluate(() => {
    type Attr = { count: number; array: ArrayLike<number> };
    type O = { isMesh?: boolean; geometry?: { getAttribute(n: string): Attr | undefined } };
    const v = (window as unknown as { __3dmarkerViewer: { getObject(): { traverse(f: (o: O) => void): void } | null } }).__3dmarkerViewer;
    let sum = 0;
    v.getObject()?.traverse((o) => {
      const p = o.isMesh ? o.geometry?.getAttribute('position') : undefined;
      if (!p) return;
      for (let i = 0; i < p.count * 3; i++) sum += Math.abs(p.array[i]) * ((i % 7) + 1);
    });
    return sum;
  });
}

/** Posed bounds of the skinned meshes (bone transforms applied) and a few bone rotations. */
async function posedState(page: Page): Promise<{ box: number[]; bones: number[] }> {
  return page.evaluate(() => {
    type V = { x: number; y: number; z: number };
    type O = {
      isSkinnedMesh?: boolean;
      isBone?: boolean;
      name: string;
      quaternion: { x: number; y: number; z: number; w: number };
      computeBoundingBox(): void;
      boundingBox: { min: V; max: V };
    };
    const v = (window as unknown as { __3dmarkerViewer: { getObject(): { traverse(f: (o: O) => void): void; updateMatrixWorld(f: boolean): void } | null } }).__3dmarkerViewer;
    const root = v.getObject()!;
    root.updateMatrixWorld(true);
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const bones: number[] = [];
    root.traverse((o) => {
      if (o.isSkinnedMesh) {
        o.computeBoundingBox();
        const b = o.boundingBox;
        box[0] = Math.min(box[0], b.min.x); box[1] = Math.min(box[1], b.min.y); box[2] = Math.min(box[2], b.min.z);
        box[3] = Math.max(box[3], b.max.x); box[4] = Math.max(box[4], b.max.y); box[5] = Math.max(box[5], b.max.z);
      }
      if (o.isBone && /^(Hips|Spine|LeftArm|RightArm|LeftForeArm|RightForeArm|LeftUpLeg|RightUpLeg|Head)$/.test(o.name)) {
        bones.push(o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w);
      }
    });
    return { box, bones };
  });
}

const maxDiff = (a: number[], b: number[]) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);

/** A tiny BVH clip in Mixamo naming (T-pose rest, arms along ±X): both arms flap up and down. */
function flapBvh(): string {
  const joint = (name: string, off: string, children: string, indent: string) =>
    `${indent}JOINT ${name}\n${indent}{\n${indent}  OFFSET ${off}\n${indent}  CHANNELS 3 Zrotation Xrotation Yrotation\n${children}${indent}}\n`;
  const end = (off: string, indent: string) => `${indent}End Site\n${indent}{\n${indent}  OFFSET ${off}\n${indent}}\n`;
  const arm = (side: 'Left' | 'Right', s: number, ind: string) =>
    joint(`${side}Arm`, `${s * 6} 0 0`, joint(`${side}ForeArm`, `${s * 12} 0 0`, end(`${s * 10} 0 0`, `${ind}    `), `${ind}  `), ind);
  const leg = (side: 'Left' | 'Right', s: number, ind: string) =>
    joint(`${side}UpLeg`, `${s * 4} -2 0`, joint(`${side}Leg`, '0 -20 0', end('0 -20 0', `${ind}    `), `${ind}  `), ind);
  const hierarchy =
    'HIERARCHY\nROOT Hips\n{\n  OFFSET 0 0 0\n  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n' +
    joint('Spine', '0 8 0', joint('Neck', '0 14 0', joint('Head', '0 4 0', end('0 8 0', '        '), '      '), '    ') + arm('Left', 1, '    ') + arm('Right', -1, '    '), '  ') +
    leg('Left', 1, '  ') +
    leg('Right', -1, '  ') +
    '}\n';
  // Channel order: Hips(6), Spine, Neck, Head, LeftArm, LeftForeArm, RightArm, RightForeArm, LeftUpLeg, LeftLeg, RightUpLeg, RightLeg.
  const frame = (a: number) => [0, 44, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, a, 0, 0, 0, 0, 0, -a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].join(' ');
  const frames = [0, 35, 70, 35, 0, -35, 0];
  return `${hierarchy}MOTION\nFrames: ${frames.length}\nFrame Time: 0.2\n${frames.map(frame).join('\n')}\n`;
}

test.describe('AI providers dialog', () => {
  test('adds an OpenAI provider, tests the connection (mocked) and keeps the key only when remembered', async ({ page, context }) => {
    await offline(context);
    const api = await mockOpenAi(context);
    await open(page);
    await expect(page.getByTestId('ai-settings-count')).toHaveText('0');
    await page.getByTestId('ai-settings-open').click();
    const dialog = page.getByTestId('ai-settings-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('ai-add-provider').click();
    await page.getByTestId('ai-add-kind-openai').click();
    const key = dialog.locator('[data-testid^="ai-key-"]');
    await expect(key).toBeVisible();
    const id = (await key.getAttribute('data-testid'))!.replace('ai-key-', '');
    await key.fill('sk-e2e-dialog-123');
    await expect(page.getByTestId(`ai-status-${id}`)).toContainText(/Ready/);
    await page.getByTestId(`ai-test-${id}`).click();
    await expect(page.getByTestId(`ai-test-result-${id}`)).toContainText(/Connected|works|OK/i);
    expect(api.models).toEqual(['Bearer sk-e2e-dialog-123']);
    await page.screenshot({ path: `${SHOTS}/ai-providers-dialog.png` });
    await page.getByTestId('ai-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('ai-settings-count')).toHaveText('1');

    // Not remembered: the key lives in this tab's session storage only.
    expect(await page.evaluate(() => localStorage.getItem('3dmarker:ai-settings'))).toContain('"kind":"openai"');
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('sk-e2e-dialog-123');
    expect(await page.evaluate(() => JSON.stringify({ ...sessionStorage }))).toContain('sk-e2e-dialog-123');
    await page.reload();
    await page.getByTestId('ai-settings-open').click();
    await page.getByTestId(`ai-select-${id}`).click();
    await expect(page.getByTestId(`ai-key-${id}`)).toHaveValue('sk-e2e-dialog-123'); // same tab
    const other = await context.newPage();
    await other.goto('/');
    await other.getByTestId('ai-settings-open').click();
    await other.getByTestId(`ai-select-${id}`).click();
    await expect(other.getByTestId(`ai-key-${id}`)).toHaveValue(''); // a new tab starts without it
    await other.close();

    // Remembered: the key moves to local storage and a new tab has it.
    await page.getByTestId('ai-remember-keys').check({ force: true });
    await expect.poll(() => page.evaluate(() => JSON.stringify({ ...localStorage }))).toContain('sk-e2e-dialog-123');
    const third = await context.newPage();
    await third.goto('/');
    await third.getByTestId('ai-settings-open').click();
    await third.getByTestId(`ai-select-${id}`).click();
    await expect(third.getByTestId(`ai-key-${id}`)).toHaveValue('sk-e2e-dialog-123');
    await third.close();

    // Turning it off again removes it from local storage.
    await page.getByTestId('ai-remember-keys').uncheck({ force: true });
    await expect.poll(() => page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain('sk-e2e-dialog-123');
  });
});

test.describe('AI preparation and views (mocked OpenAI)', () => {
  test('style + T-pose + full body → compare → accept; views generated per prompt, one uploaded, one cleared; fusion is closed and coloured', async ({
    page,
    context,
  }) => {
    await offline(context);
    await seedOpenAi(context);
    const api = await mockOpenAi(context);
    const errors = collectErrors(page);
    await open(page);
    await loadSample(page, SAMPLE.mascot);

    await step(page, 'prep');
    await page.getByTestId('ai-prep-subject').selectOption('human');
    await page.getByTestId('style-search').fill('clay');
    await page.getByTestId('style-claymation').click();
    await expect(page.getByTestId('style-claymation')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('ai-prep-tpose').check({ force: true });
    await page.getByTestId('ai-prep-complete').check({ force: true });
    await page.getByTestId('ai-prep-run').click();
    await expect(page.getByTestId('ai-prep-result')).toBeVisible({ timeout: 30_000 });
    expect(api.edits).toHaveLength(1);
    const prep = api.edits[0];
    expect(prep.auth).toBe('Bearer sk-e2e-features');
    expect(prep.prompt).toMatch(/symmetric T-pose/);
    expect(prep.prompt).toMatch(/plasticine claymation/);
    expect(prep.prompt).toMatch(/complete the whole full-length body/);
    await page.getByTestId('ai-prep-result').screenshot({ path: `${SHOTS}/ai-prep-compare.png` });
    await page.getByTestId('ai-prep-accept').click();
    await expect(page.locator('#step-panel-prep [data-testid="revert-original"]')).toBeVisible();
    await step(page, 'image');
    await expect(page.locator('#step-panel-image')).toContainText('sample-mascot-ai.png');

    // Views: the missing five, each answered with its own silhouette.
    await step(page, 'views');
    await page.getByTestId('views-generate-missing').click();
    await expect(page.getByTestId('views-count')).toContainText('6/6', { timeout: 60_000 });
    expect(api.edits.slice(1).map((c) => c.view)).toEqual(['back', 'left', 'right', 'top', 'bottom']);
    // The accepted front already is in T-pose: views keep the reference's pose instead of re-posing it.
    for (const c of api.edits.slice(1)) {
      expect(c.prompt, c.view).toMatch(/Keep exactly the same pose as the reference/);
      expect(c.prompt, c.view).not.toMatch(/Re-pose the subject/);
      expect(c.prompt, c.view).toMatch(/Output exactly one image of this single view/);
    }
    // Later views are generated with the earlier ones as references.
    expect(api.edits[api.edits.length - 1].images).toBeGreaterThan(api.edits[1].images);
    for (const v of ['back', 'left', 'right', 'top', 'bottom']) await expect(page.getByTestId(`view-${v}`)).toHaveAttribute('data-filled', 'true');

    // Replace the top view by an upload, clear the bottom one.
    await page.getByTestId('view-clear-top').click();
    await expect(page.getByTestId('view-top')).toHaveAttribute('data-filled', 'false');
    await page
      .getByTestId('view-upload-top')
      .locator('input[type=file]')
      .setInputFiles({ name: 'my-top.png', mimeType: 'image/png', buffer: characterView('top', [14, 165, 233, 255]) });
    await expect(page.getByTestId('view-top')).toHaveAttribute('data-filled', 'true');
    await page.getByTestId('view-clear-bottom').click();
    await expect(page.getByTestId('view-bottom')).toHaveAttribute('data-filled', 'false');
    await expect(page.getByTestId('views-count')).toContainText('5/6');
    await page.getByTestId('views-panel').screenshot({ path: `${SHOTS}/views-panel.png` });

    // Multi-view fusion (the depth model is unreachable → silhouette hull, with a warning in the progress label).
    await step(page, '3d');
    await page.getByTestId('driver-select').selectOption('multiview-fusion');
    await generate(page);
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
    const colours = await page.evaluate(() => {
      type O = { isMesh?: boolean; geometry: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } | undefined }; material: { vertexColors: boolean; map: unknown } };
      const v = (window as unknown as { __3dmarkerViewer: { getExportObject(): { traverse(f: (o: O) => void): void } | null } }).__3dmarkerViewer;
      const out: { vertexColors: boolean; map: boolean; distinct: number }[] = [];
      v.getExportObject()!.traverse((o) => {
        const c = o.isMesh ? o.geometry.getAttribute('color') : undefined;
        if (!c) return;
        const seen = new Set<string>();
        for (let i = 0; i < c.count; i += 7) seen.add([c.getX(i), c.getY(i), c.getZ(i)].map((x) => Math.round(x * 4)).join(','));
        out.push({ vertexColors: o.material.vertexColors, map: !!o.material.map, distinct: seen.size });
      });
      return out[0] ?? null;
    });
    expect(colours).toMatchObject({ vertexColors: true, map: false });
    expect(colours!.distinct).toBeGreaterThanOrEqual(4); // shirt colours of several views + skin + hair
    await page.getByTestId('viewer').screenshot({ path: `${SHOTS}/ai-views-fusion.png` });
    expect(errors).toEqual([]);
  });
});

test.describe('human detail', () => {
  test('MediaPipe unreachable → detection is reported unavailable; the ML driver still fails with the Hugging Face error', async ({ page, context }) => {
    await offline(context);
    await seedOpenAi(context); // the AI step detects people only once a provider could use the result
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page);
    await loadSample(page, SAMPLE.tpose);
    await step(page, 'prep');
    await expect(page.getByTestId('ai-prep-detect')).toHaveAttribute('data-state', 'unavailable', { timeout: 45_000 });
    await step(page, '3d');
    await page.getByTestId('driver-select').selectOption('depth-anything-v2-small');
    const note = page.getByTestId('human-detail');
    await expect(note).toBeVisible();
    await expect(note).toHaveAttribute('data-state', /unavailable|pending/);
    if ((await note.getAttribute('data-state')) === 'pending') await page.getByTestId('human-detect').click();
    await expect(note).toHaveAttribute('data-state', 'unavailable', { timeout: 45_000 });
    await expect(note).toContainText(/could not|unavailable/i);
    await page.getByTestId('generate').click();
    await expect(page.getByTestId('error')).toContainText(/Hugging Face/, { timeout: 45_000 });
    await expect(page.getByTestId('generate')).toBeEnabled();
    await page.getByTestId('lang-tr').click();
    await expect(note).toHaveAttribute('data-state', 'unavailable');
    await page.screenshot({ path: `${SHOTS}/human-detail-unavailable.png` });
    expect(errors).toEqual([]);
  });
});

test.describe('sculpt', () => {
  test('draw strokes change the surface and undo restores it; the depth editor rebuilds a depth model', async ({ page, context }) => {
    await offline(context);
    const errors = collectErrors(page);
    await open(page);
    await loadSample(page, SAMPLE.mascot);
    await step(page, '3d');
    await page.getByTestId('driver-select').selectOption('silhouette-inflate');
    await generate(page);
    const original = await positionChecksum(page);

    await step(page, 'edit');
    await page.getByTestId('sculpt-toggle').click();
    await expect(page.getByTestId('sculpt-panel')).toHaveAttribute('data-active', 'true');
    await page.getByTestId('brush-draw').click();
    const box = (await page.getByTestId('viewer').boundingBox())!;
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    for (let s = 0; s < 3; s++) {
      await page.mouse.move(cx - 70, cy - 30 + s * 25);
      await page.mouse.down();
      for (let i = 0; i <= 14; i++) await page.mouse.move(cx - 70 + i * 10, cy - 30 + s * 25 + (i % 2) * 3);
      await page.mouse.up();
    }
    await expect(page.getByTestId('sculpt-strokes')).toHaveAttribute('data-strokes', '3');
    const sculpted = await positionChecksum(page);
    expect(Math.abs(sculpted - original)).toBeGreaterThan(1e-3);
    await page.getByTestId('viewer').screenshot({ path: `${SHOTS}/sculpt-draw.png` });
    for (let s = 0; s < 3; s++) await page.getByTestId('sculpt-undo').click();
    await expect.poll(() => positionChecksum(page)).toBeCloseTo(original, 2);
    await page.getByTestId('sculpt-redo').click();
    await expect.poll(async () => Math.abs((await positionChecksum(page)) - original)).toBeGreaterThan(1e-3);
    await page.getByTestId('sculpt-toggle').click();
    await expect(page.getByTestId('sculpt-panel')).toHaveAttribute('data-active', 'false');

    // Depth map editor: paint a raised stroke and apply → a rebuilt model with different depth.
    await step(page, '3d');
    await page.getByTestId('discard-sculpt').click();
    await expect(page.getByTestId('mesh-paused')).toHaveCount(0);
    await step(page, 'edit');
    const beforeDepth = await positionChecksum(page);
    await page.getByTestId('depth-edit-open').click();
    await expect(page.getByTestId('depth-editor')).toBeVisible();
    await page.getByTestId('depth-brush-raise').click();
    const stage = (await page.getByTestId('depth-stage').boundingBox())!;
    for (let s = 0; s < 2; s++) {
      await page.mouse.move(stage.x + stage.width / 2 - 40, stage.y + stage.height / 2 + s * 20);
      await page.mouse.down();
      for (let i = 0; i <= 10; i++) await page.mouse.move(stage.x + stage.width / 2 - 40 + i * 8, stage.y + stage.height / 2 + s * 20);
      await page.mouse.up();
    }
    await page.getByTestId('depth-editor').screenshot({ path: `${SHOTS}/depth-editor.png` });
    await page.getByTestId('depth-apply').click();
    await expect(page.getByTestId('depth-editor')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await positionChecksum(page)) - beforeDepth)).toBeGreaterThan(1e-3);
    expect(errors).toEqual([]);
  });
});

test.describe('rig and animation', () => {
  test('T-pose mannequin: fused → auto-rig → skeleton, three clips deform the mesh, BVH import, animated GLB', async ({ page, context }) => {
    test.setTimeout(180_000);
    await offline(context);
    const errors = collectErrors(page);
    await open(page);
    await loadSample(page, SAMPLE.tpose);
    // The sample brings its back / left / right views.
    await step(page, 'views');
    for (const v of ['back', 'left', 'right']) await expect(page.getByTestId(`view-${v}`)).toHaveAttribute('data-filled', 'true');
    await expect(page.getByTestId('views-count')).toContainText('4/6');
    await page.getByTestId('views-panel').screenshot({ path: `${SHOTS}/tpose-views.png` });

    await step(page, '3d');
    await page.getByTestId('driver-select').selectOption('multiview-fusion');
    await generate(page);
    await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
    await page.getByTestId('viewer').screenshot({ path: `${SHOTS}/tpose-fused.png` });

    await step(page, 'rig');
    await page.getByTestId('rig-auto').click();
    await expect(page.getByTestId('rig-status')).toBeVisible({ timeout: 90_000 });
    expect(Number(await page.getByTestId('rig-status').getAttribute('data-bones'))).toBeGreaterThanOrEqual(15);
    // MediaPipe is unreachable: the joints come from the T-pose silhouette.
    await expect(page.getByTestId('rig-status')).toHaveAttribute('data-method', /silhouette|arms-down|proportional/);
    await page.getByTestId('rig-skeleton').check({ force: true });
    await page.getByTestId('viewer').screenshot({ path: `${SHOTS}/tpose-skeleton.png` });
    const rest = await posedState(page);
    expect(rest.box.every(Number.isFinite)).toBe(true);

    // The viewer picked up the swapped-in skinned mesh (rescanObject): display modes apply to it.
    const skinnedMaterial = () =>
      page.evaluate(() => {
        type O = { isSkinnedMesh?: boolean; material: { type: string } };
        const v = (window as unknown as { __3dmarkerViewer: { getObject(): { traverse(f: (o: O) => void): void } | null } }).__3dmarkerViewer;
        let type = '';
        v.getObject()!.traverse((o) => {
          if (o.isSkinnedMesh) type = o.material.type;
        });
        return type;
      });
    expect(await skinnedMaterial()).toBe('MeshStandardMaterial');
    await page.getByTestId('view-clay').click();
    await expect.poll(skinnedMaterial).toBe('MeshMatcapMaterial');
    await page.getByTestId('view-clay').click();
    await expect.poll(skinnedMaterial).toBe('MeshStandardMaterial');

    for (const clip of ['walk', 'wave-both', 'jumping-jacks']) {
      await page.getByTestId(`anim-${clip}`).click();
      await expect(page.getByTestId('anim-now')).not.toContainText(/Nothing/);
      await page.waitForTimeout(450);
      const a = await posedState(page);
      await page.waitForTimeout(350);
      const b = await posedState(page);
      expect(maxDiff(a.bones, rest.bones), `${clip} moves bones`).toBeGreaterThan(0.02);
      expect(maxDiff(a.bones, b.bones), `${clip} animates over time`).toBeGreaterThan(1e-3);
      expect(maxDiff(a.box, rest.box), `${clip} deforms the skinned mesh`).toBeGreaterThan(0.01);
      await page.getByTestId('viewer').screenshot({ path: `${SHOTS}/tpose-anim-${clip}.png` });
    }
    await page.getByTestId('anim-stop').click();

    // Import a BVH clip (Mixamo bone names) → retargeted, listed, playing, selected for export.
    await page.getByTestId('anim-import').setInputFiles({ name: 'flap.bvh', mimeType: 'text/plain', buffer: Buffer.from(flapBvh()) });
    await expect(page.getByTestId('anim-import-flap')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('anim-now')).toContainText('flap');
    // The flap passes through the rest pose (0° at 0 s and 0.8 s of its 1.2 s loop): on a slow runner a single
    // sample can land there, so sample until a flapping pose shows up.
    await expect
      .poll(async () => maxDiff((await posedState(page)).bones, rest.bones), { timeout: 10_000, intervals: [150] })
      .toBeGreaterThan(0.02);

    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('export-glb').click()]);
    expect(dl.suggestedFilename()).toBe('sample-tpose-multiview-fusion-rigged.glb');
    const glb = await readFile(await dl.path());
    expect(glb.readUInt32LE(0)).toBe(0x46546c67); // 'glTF'
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8')) as {
      skins?: { joints: number[] }[];
      animations?: { name: string; channels: unknown[] }[];
      meshes?: { primitives: { attributes: Record<string, number> }[] }[];
    };
    expect(json.skins?.length).toBe(1);
    expect(json.skins![0].joints.length).toBeGreaterThanOrEqual(15);
    const names = (json.animations ?? []).map((a) => a.name);
    expect(names.length).toBeGreaterThanOrEqual(40);
    expect(names).toEqual(expect.arrayContaining(['walk', 'wave-both', 'jumping-jacks', 'flap']));
    const prim = json.meshes!.flatMap((m) => m.primitives).find((p) => 'JOINTS_0' in p.attributes)!;
    expect(prim.attributes).toHaveProperty('WEIGHTS_0');
    expect(prim.attributes).toHaveProperty('COLOR_0'); // fusion's vertex colours survive the rig

    // Removing the rig restores the static mesh.
    await page.getByTestId('rig-remove').click();
    await expect(page.getByTestId('rig-auto')).toBeVisible();
    await expect(page.getByTestId('export-animations')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('navigation, language and phone layout', () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('every step fits 375 px in both languages without console errors', async ({ page, context }) => {
    await offline(context);
    const errors = collectErrors(page);
    await open(page, 'tr');
    await page.getByTestId('sample-3').click();
    await expect(page.getByTestId('generate')).toBeEnabled();
    for (const lang of ['tr', 'en'] as const) {
      await page.getByTestId(`lang-${lang}`).click();
      await expect(page.locator('html')).toHaveAttribute('lang', lang);
      for (const id of ['image', 'prep', 'views', '3d', 'edit', 'rig'] as const) {
        await page.getByTestId(`step-${id}`).click();
        await expect(page.getByTestId(`step-${id}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator(`#step-panel-${id}`)).toBeVisible();
        const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, inner: window.innerWidth }));
        expect(m.inner, `${lang}/${id}`).toBe(375);
        expect(m.scroll, `${lang}/${id}`).toBeLessThanOrEqual(m.client);
        if (lang === 'en') await page.screenshot({ path: `${SHOTS}/phone-${id}.png` });
      }
    }
    // The providers dialog fits too.
    await page.getByTestId('ai-settings-open').click();
    await expect(page.getByTestId('ai-settings-dialog')).toBeVisible();
    await page.getByTestId('ai-add-provider').click();
    const m = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(m.scroll).toBeLessThanOrEqual(m.client);
    await page.screenshot({ path: `${SHOTS}/phone-ai-dialog.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('ai-settings-dialog')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
