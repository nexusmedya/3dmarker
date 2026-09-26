/**
 * Driver registry — the list shown in the driver select box.
 * Add a new strategy by implementing `Driver` (see src/core/types.ts) and
 * appending it to the matching category list.
 */
import type { Driver } from '../core/types';
import { ML_DRIVERS } from './ml';
import { HEURISTIC_DRIVERS } from './heuristic';
import { MULTIVIEW_DRIVERS } from './multiview';
import { CLOUD_DRIVERS } from './cloud';

export const DRIVERS: Driver[] = [...ML_DRIVERS, ...HEURISTIC_DRIVERS, ...MULTIVIEW_DRIVERS, ...CLOUD_DRIVERS];

export function getDriver(id: string): Driver | undefined {
  return DRIVERS.find((d) => d.id === id);
}

export const DEFAULT_DRIVER_ID = 'depth-anything-v2-small';
