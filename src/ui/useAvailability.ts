/**
 * Runs driver.isAvailable() whenever the selected driver changes, and again
 * when `refreshKey` changes (e.g. the AI provider settings a driver reads).
 * A re-check for the same driver keeps showing the previous answer until the
 * new one arrives (no "Checking…" flash while settings are typed).
 */
import { useEffect, useState } from 'react';
import type { Availability, Driver } from '../core/types';

/** null = the driver has no check; 'checking' while the first check for this driver runs. */
export function useAvailability(driver: Driver, refreshKey?: unknown): Availability | 'checking' | null {
  const [result, setResult] = useState<{ id: string; value: Availability } | null>(null);
  useEffect(() => {
    if (!driver.isAvailable) return;
    let alive = true;
    driver
      .isAvailable()
      .then((value) => alive && setResult({ id: driver.id, value }))
      .catch(() => alive && setResult({ id: driver.id, value: { ok: false } }));
    return () => {
      alive = false;
    };
  }, [driver, refreshKey]);
  if (!driver.isAvailable) return null;
  return result && result.id === driver.id ? result.value : 'checking';
}
