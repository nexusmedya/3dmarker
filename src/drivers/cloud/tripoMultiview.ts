/**
 * Cloud driver: several views → full 3D via Tripo3D's multi-view task. Sends
 * the front plus the left / back / right views (uploaded or AI-generated, see
 * DriverInput.views) to our server (POST /api/tripo/multiview-tasks), then
 * polls and downloads like the single-image driver (shared task runner).
 * Top / bottom views are not used: the task takes these four only.
 */
import type { Driver, DriverInput, DriverResult, I18nText, ParamSpec, ViewId } from '../../core/types';
import { throwIfAborted } from '../../core/types';
import { LocalizedError } from '../../core/errors';
import { TRIPO_MULTIVIEW_FIELDS, TRIPO_MULTIVIEW_TASKS_PATH, type TripoMultiviewField } from './api';
import {
  TRIPO_PARAMS,
  checkTripoFile,
  createTripoTaskRunner,
  tripoParamsFrom,
  type TripoDriverOptions,
  type TripoParams,
} from './tripo';

const VIEW_NAME: Record<TripoMultiviewField, I18nText> = {
  front: { tr: 'ön', en: 'front' },
  left: { tr: 'sol', en: 'left' },
  back: { tr: 'arka', en: 'back' },
  right: { tr: 'sağ', en: 'right' },
};

const SIDE_VIEWS: Exclude<TripoMultiviewField, 'front'>[] = ['left', 'back', 'right'];

const T = {
  needsViews: (missing: TripoMultiviewField[]): I18nText => ({
    tr: `Tripo3D çoklu görünüm, ön görünümün yanında en az bir görünüm daha ister: ${missing.map((v) => VIEW_NAME[v].tr).join(', ')} görünümlerinden birini “Görünümler” panelinden yükleyin ya da yapay zekâ ile üretin (üst/alt görünümler kullanılmaz).`,
    en: `Tripo3D multi-view needs at least one more view besides the front: add the ${missing.map((v) => VIEW_NAME[v].en).join(', ')} view in the Views panel (upload it or generate it with AI; top/bottom views are not used).`,
  }),
  badView: (view: TripoMultiviewField, why: I18nText): I18nText => ({
    tr: `${VIEW_NAME[view].tr[0].toLocaleUpperCase('tr')}${VIEW_NAME[view].tr.slice(1)} görünüm: ${why.tr}`,
    en: `${VIEW_NAME[view].en[0].toUpperCase()}${VIEW_NAME[view].en.slice(1)} view: ${why.en}`,
  }),
  upload: (n: number): I18nText => ({ tr: `${n} görünüm Tripo3D’ye yükleniyor`, en: `Uploading ${n} views to Tripo3D` }),
};

export interface TripoMultiviewParams extends TripoParams {
  /** Send the left view as Tripo's "right" and vice versa (see server ASSUMPTION on the side convention). */
  swapSides: boolean;
}

const PARAMS: ParamSpec[] = [
  ...TRIPO_PARAMS,
  {
    kind: 'boolean',
    key: 'swapSides',
    label: { tr: 'Sol/sağ görünümleri değiştir', en: 'Swap left/right views' },
    hint: {
      tr: 'Model yanları ters birleştirilmiş çıkarsa açın.',
      en: 'Turn on if the model comes out with its sides mixed up.',
    },
    default: false,
  },
];

export function tripoMultiviewParamsFrom(p: DriverInput['params']): TripoMultiviewParams {
  return { ...tripoParamsFrom(p), swapSides: typeof p.swapSides === 'boolean' ? p.swapSides : false };
}

/** The four Tripo slots from the driver input (front falls back to the source file). */
export function pickMultiviewFiles(input: Pick<DriverInput, 'file' | 'views'>): Partial<Record<TripoMultiviewField, Blob>> {
  const out: Partial<Record<TripoMultiviewField, Blob>> = { front: input.views.front?.file ?? input.file };
  for (const v of SIDE_VIEWS) {
    const view = input.views[v as ViewId];
    if (view?.file && view.align?.trust !== 'off') out[v] = view.file; // views switched off in the Views panel are not uploaded
  }
  return out;
}

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

/** Multipart body for POST /api/tripo/multiview-tasks (left/right exchanged when `swapSides`). */
export function buildMultiviewForm(views: Partial<Record<TripoMultiviewField, Blob>>, params: TripoMultiviewParams): FormData {
  const form = new FormData();
  for (const field of TRIPO_MULTIVIEW_FIELDS) {
    const source: TripoMultiviewField = params.swapSides && field === 'left' ? 'right' : params.swapSides && field === 'right' ? 'left' : field;
    const file = views[source];
    if (file) form.append(field, file, `${field}.${EXT[file.type] ?? 'png'}`);
  }
  if (params.modelVersion !== 'default') form.append('model_version', params.modelVersion);
  form.append('texture', String(params.texture));
  form.append('pbr', String(params.pbr));
  if (params.faceLimit > 0) form.append('face_limit', String(params.faceLimit));
  return form;
}

export function createTripoMultiviewDriver(options: TripoDriverOptions = {}): Driver {
  const runner = createTripoTaskRunner(options);

  async function run(input: DriverInput): Promise<DriverResult> {
    const params = tripoMultiviewParamsFrom(input.params);
    throwIfAborted(input.signal);
    const views = pickMultiviewFiles(input);
    const sides = SIDE_VIEWS.filter((v) => views[v]);
    if (sides.length === 0) throw new LocalizedError(T.needsViews(SIDE_VIEWS));
    for (const field of TRIPO_MULTIVIEW_FIELDS) {
      const file = views[field];
      const problem = file && checkTripoFile(file);
      if (problem) throw new LocalizedError(T.badView(field, problem));
    }
    return runner.run(input, params, {
      path: TRIPO_MULTIVIEW_TASKS_PATH,
      form: buildMultiviewForm(views, params),
      uploadLabel: T.upload(1 + sides.length),
    });
  }

  return {
    id: 'tripo3d-multiview',
    name: { tr: 'Tripo3D çoklu görünüm (bulut, tam 3B)', en: 'Tripo3D multi-view (cloud, full 3D)' },
    description: {
      tr: 'Ön görünümü sol, arka ve/veya sağ görünümlerle birlikte Tripo3D’ye gönderir; arka ve yanlar tahmin edilmek yerine verdiğiniz görünümlerden kurulur, dokulu ve kapalı bir 3B model (GLB) döner. Görünümleri “Görünümler” panelinden yükleyin ya da yapay zekâ ile üretin. Tripo3D API anahtarı gerektirir, kredi harcar; görseller üçüncü taraf bir hizmete yüklenir. Kendi 3D Marker API sunucunuzu gerektirir; çevrimiçi demoda çalışmaz.',
      en: 'Sends the front view together with the left, back and/or right views to Tripo3D; the back and sides are built from your views instead of being guessed, returning a textured, closed 3D model (GLB). Add the views in the Views panel (upload them or generate them with AI). Needs a Tripo3D API key and uses credits; the images are uploaded to a third-party service. Needs your own 3D Marker API server; not available on the online demo.',
    },
    category: 'cloud',
    badges: ['api-key', 'full-3d', 'closed-mesh', 'multi-view'],
    params: PARAMS,
    producesDepth: false,
    views: 'required',
    // At least one of left / back / right: checked in run() (minViews cannot say "any of").
    minViews: [],
    isAvailable: runner.isAvailable,
    run,
  };
}

export const tripoMultiviewDriver: Driver = createTripoMultiviewDriver();
