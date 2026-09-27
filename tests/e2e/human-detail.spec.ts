/**
 * Human detection (MediaPipe) failing in the browser: the step-4 card says
 * why, that generation continues without face / hand relief, and its retry
 * downloads the models again at once — even after a slow (stalled) failure,
 * which is otherwise remembered for minutes.
 */
import { expect, test, type Page } from '@playwright/test';

const MODEL_HOST = /storage\.googleapis\.com/;

async function openTPose(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('step-image')).toBeVisible();
  await page.getByTestId('lang-tr').click();
  await page.getByTestId('step-image').click();
  await page.getByTestId('sample-3').click();
  await expect(page.getByTestId('generate')).toBeEnabled();
  await page.getByTestId('step-3d').click();
  await page.getByTestId('driver-select').selectOption('depth-anything-v2-small');
}

test('MediaPipe blocked → reason, consequence and a working retry (Turkish)', async ({ page, context }) => {
  await context.route(/huggingface\.co|hf\.co|cdn\.jsdelivr\.net/, (r) => r.abort('internetdisconnected'));
  let modelRequests = 0;
  // Slow failure (≥ 5 s, like a stalled download): analyze.ts remembers it, so only an explicit retry re-downloads.
  await context.route(MODEL_HOST, async (r) => {
    modelRequests++;
    await new Promise((res) => setTimeout(res, 5_500));
    await r.abort('timedout').catch(() => undefined);
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openTPose(page);

  const note = page.getByTestId('human-detail');
  await expect(note).toBeVisible();
  if ((await note.getAttribute('data-state')) === 'pending') await page.getByTestId('human-detect').click();
  await expect(note).toHaveAttribute('data-state', 'unavailable', { timeout: 60_000 });
  const box = page.getByTestId('human-unavailable');
  await expect(box).toHaveAttribute('role', 'alert');
  await expect(page.getByTestId('human-unavailable-reason')).toContainText('modeli yüklenemedi');
  await expect(box).toContainText('3B üretim yine çalışır, ancak yüz ve el kabartması eklenmez');
  const before = modelRequests;
  expect(before).toBeGreaterThan(0);

  await page.getByTestId('human-retry').click();
  await expect(note).toHaveAttribute('data-state', /analyzing|unavailable/);
  await expect.poll(() => modelRequests, { timeout: 15_000 }).toBeGreaterThan(before);
  await expect(note).toHaveAttribute('data-state', 'unavailable', { timeout: 60_000 });
  await expect(page.getByTestId('human-retry')).toBeEnabled();

  await page.getByTestId('lang-en').click();
  await expect(box).toContainText('Generation still works, but without face and hand relief');
  await expect(page.getByTestId('human-retry')).toHaveText(/Try again/);
  expect(errors).toEqual([]);
});
