/**
 * Hybrid drivers: in-browser ML depth combined with silhouette volume
 * heuristics into closed bodies (listed with the ML drivers).
 */
import type { Driver } from '../../core/types';
import { depthVolumeDriver } from './depthVolume';

export const HYBRID_DRIVERS: Driver[] = [depthVolumeDriver];
