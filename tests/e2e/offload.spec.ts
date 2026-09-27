/**
 * Multi-view fusion and rig skin weights run in the geometry worker
 * (src/workers/geometry.worker.ts): the worker starts, the fused model and the
 * rig come out as before, Cancel stops a fusion at once, and the page stays
 * responsive (main-thread long tasks are reported as annotations, not
 * asserted: they depend on the machine and on the dev server's React build).
 */
import { expect, test, type Page } from '@playwright/test';

/** Sample buttons (src/app/samples.ts): 3 = T-pose mannequin with back / left / right views. */
const TPOSE = 3;

async function step(page: Page, id: string) {
  await page.getByTestId(`step-${id}`).click();
  await expect(page.getByTestId(`step-${id}`)).toHaveAttribute('aria-selected', 'true');
}

type Task = { start: number; dur: number };
const longTasks = (page: Page, from: number) =>
  page.evaluate((t0) => ((window as unknown as { __longTasks: Task[] }).__longTasks ?? []).filter((e) => e.start >= t0), from);
const now = (page: Page) => page.evaluate(() => performance.now());

test('fusion and auto-rig run in the geometry worker; Cancel stops a fusion', async ({ page, context }) => {
  test.setTimeout(180_000);
  await context.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net|storage\.googleapis\.com/, (r) => r.abort('internetdisconnected'));
  await page.addInitScript(() => {
    const w = window as unknown as { __longTasks: Task[] };
    w.__longTasks = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) w.__longTasks.push({ start: e.startTime, dur: e.duration });
      }).observe({ type: 'longtask', buffered: true });
    } catch {
      /* no Long Tasks API */
    }
  });
  const workers: string[] = [];
  page.on('worker', (w) => workers.push(w.url()));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/');
  await page.getByTestId('lang-en').click();
  await step(page, 'image');
  await page.getByTestId(`sample-${TPOSE}`).click();
  await step(page, '3d');
  await page.getByTestId('driver-select').selectOption('multiview-fusion');

  // Cancel mid-fusion: the UI is back at once (the worker job is dropped).
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('cancel')).toBeVisible();
  await page.getByTestId('cancel').click();
  await expect(page.getByTestId('generate')).toBeEnabled({ timeout: 5_000 });
  await expect(page.getByTestId('error')).toHaveCount(0);
  expect(workers.some((u) => /geometry\.worker/.test(u)), 'geometry worker started').toBe(true);

  const t0 = await now(page);
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-triangles', /^[1-9]\d*$/, { timeout: 90_000 });
  await expect(page.getByTestId('mesh-stats')).toHaveAttribute('data-watertight', 'true');
  const fusionTasks = await longTasks(page, t0);

  await step(page, 'rig');
  const t1 = await now(page);
  await page.getByTestId('rig-auto').click();
  await expect(page.getByTestId('rig-status')).toBeVisible({ timeout: 90_000 });
  expect(Number(await page.getByTestId('rig-status').getAttribute('data-bones'))).toBeGreaterThanOrEqual(15);
  const rigTasks = await longTasks(page, t1);
  // One geometry worker serves both (the skin mesh is prepared there once).
  expect(workers.filter((u) => /geometry\.worker/.test(u))).toHaveLength(1);

  const fmt = (ts: Task[]) => ts.map((t) => Math.round(t.dur)).join(', ') || 'none';
  test.info().annotations.push({ type: 'long tasks (fusion, ms)', description: fmt(fusionTasks) }, { type: 'long tasks (rig, ms)', description: fmt(rigTasks) });
  expect(errors).toEqual([]);
});
