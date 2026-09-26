import type { Driver } from '../../core/types';
import { aiModelDriver } from './aiModel';
import { tripoDriver } from './tripo';
import { tripoMultiviewDriver } from './tripoMultiview';

export const CLOUD_DRIVERS: Driver[] = [tripoDriver, tripoMultiviewDriver, aiModelDriver];
