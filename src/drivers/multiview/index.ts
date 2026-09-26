import type { Driver } from '../../core/types';
import { multiviewFusionDriver } from './fusion';

/** Drivers that fuse several views (front / back / sides / top / bottom) into a full 3D model. */
export const MULTIVIEW_DRIVERS: Driver[] = [multiviewFusionDriver];
