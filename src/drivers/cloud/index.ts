import type { Driver } from '../../core/types';
import { aiModelDriver } from './aiModel';
import { createHfSpaceDriver } from './hfSpaces';
import { HF_SPACE_SPECS } from './hfSpecs';
import { tripoDriver } from './tripo';
import { tripoMultiviewDriver } from './tripoMultiview';

/** Free Hugging Face Space models (no key, work on the static demo), best first. */
export const HF_SPACE_DRIVERS: Driver[] = HF_SPACE_SPECS.map((spec) => createHfSpaceDriver(spec));

// HF Spaces first: they need no key or server, so they are the first full-3D option to try.
export const CLOUD_DRIVERS: Driver[] = [...HF_SPACE_DRIVERS, tripoDriver, tripoMultiviewDriver, aiModelDriver];
