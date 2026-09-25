/** Runs driver.isAvailable() whenever the selected driver changes. */
import { useEffect, useState } from 'react';
import type { Availability, Driver } from '../core/types';

/** null = the driver has no check; 'checking' while the check runs. */
export function useAvailability(driver: Driver): Availability | 'checking' | null {
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
  }, [driver]);
  if (!driver.isAvailable) return null;
  return result && result.id === driver.id ? result.value : 'checking';
}
