/**
 * A model host that never answers (blackholed network, stalled proxy / CDN
 * edge): the ML worker's stall timeout must end the wait. The multi-view
 * fusion falls back to the silhouettes; the depth driver shows a download
 * label at once and then a bilingual "stopped responding" error. The stall
 * timeout is shortened through the dev-only window.__3dmarkerMlConfig hook.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const SHOTS = 'test-results/screenshots';
const STALL_MS = 3_000;

async function hungHub(context: BrowserContext) {
  await context.addInitScript((ms) => {
    (window as unknown as { __3dmarkerMlConfig: object }).__3dmarkerMlConfig = { stallTimeoutMs: ms };
  }, STALL_MS);
  // Requests to the Hub are never answered; the other model hosts fail fast.
  await context.route(/huggingface\.co|hf\.co/, () => {});
  await context.route(/cdn\.jsdelivr\.net|storage\.googleapis\.com/, (r) => r.abort('internetdisconnected'));
}

async function openTpose(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('step-image')).toBeVisible();
  await page.getByTestId('lang-en').click();
  await page.getByTestId('sample-3').click();
  await expect(page.getByTestId('generate')).toBeEnabled();
  await page.getByTestId('step-3d').click();
}

test('fusion with a hung model host finishes from the silhouettes and says why', async ({ page, context }) => {
  await hungHub(context);
  await openTpose(page);
  await page.getByTestId('driver-select').selectOption('multiview-fusion');
  const t0 = Date.now();
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('cancel')).toBeVisible();
  await expect(page.getByTestId('generate')).toBeVisible({ timeout: 45_000 });
  const first = Date.now() - t0;
  expect(first).toBeLessThan(40_000);
  await expect(page.getByTestId('error')).toHaveCount(0);
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', /^[1-9]\d*$/);
  const report = page.getByTestId('fusion-report');
  await expect(report).toContainText('Depth model unavailable; using the silhouettes only');
  await expect(report).toContainText(/stopped responding/);

  // Remembered: a second run skips the wait.
  const t1 = Date.now();
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('generate')).toBeVisible({ timeout: 45_000 });
  await expect(page.getByTestId('fusion-report')).toContainText('Depth model unavailable');
  // Without the memory it would wait for the stall again (≈ the first run). The fusion
  // itself takes a few seconds, more on slow CI runners, hence the relative bound.
  expect(Date.now() - t1).toBeLessThan(Math.max(STALL_MS * 3, first - STALL_MS / 2));
  await page.screenshot({ path: `${SHOTS}/fusion-hung-host.png` });
});

test('depth driver with a hung model host shows a download label, then a stall error', async ({ page, context }) => {
  await hungHub(context);
  await openTpose(page);
  await page.getByTestId('driver-select').selectOption('depth-anything-v2-small');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('progress')).toContainText(/Loading model files/, { timeout: 10_000 });
  await expect(page.getByTestId('error')).toContainText(/stopped responding/, { timeout: 45_000 });
  await expect(page.getByTestId('generate')).toBeEnabled();
  await page.getByTestId('lang-tr').click();
  await expect(page.getByTestId('error')).toContainText(/yanıt vermiyor/);
});
