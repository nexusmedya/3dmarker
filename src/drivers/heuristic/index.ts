import type { Driver } from '../../core/types';
import { luminanceDriver } from './luminance';
import { inflateDriver } from './inflate';
import { extrudeDriver } from './extrude';

export const HEURISTIC_DRIVERS: Driver[] = [inflateDriver, extrudeDriver, luminanceDriver];
