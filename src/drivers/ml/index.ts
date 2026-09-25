/**
 * In-browser ML depth drivers (transformers.js + ONNX Runtime Web, WebGPU
 * with WASM fallback). Weights download from the Hugging Face Hub on first
 * use and are cached by the browser.
 */
import type { Driver } from '../../core/types';
import { createDepthDriver, type DepthModelSpec } from './depthDriver';

/** Depth Anything uses a ViT-S/B backbone with 14 px patches and dynamic input sizes. */
const DEPTH_ANYTHING_SIDES = [392, 518, 672, 840];

export const DEPTH_MODEL_SPECS: DepthModelSpec[] = [
  {
    id: 'depth-anything-v2-small',
    model: 'onnx-community/depth-anything-v2-small',
    name: { tr: 'Depth Anything V2 Small (hızlı)', en: 'Depth Anything V2 Small (fast)' },
    description: {
      tr: 'Tarayıcıda çalışan yapay zekâ derinlik tahmini. Küçük ve hızlı model (~25M parametre); çoğu görsel için iyi bir varsayılan. '
        + 'Göreli derinlik üretir (2.5D rölyef); görünmeyen arka yüzü yeniden oluşturmaz.',
      en: 'In-browser AI depth estimation. Small, fast model (~25M parameters); a good default for most images. '
        + 'Produces relative depth (2.5D relief); it does not reconstruct the hidden back side.',
    },
    downloadSizeMB: 50,
    convention: 'disparity',
    nativeSide: 518,
    patchMultiple: 14,
    detailSides: DEPTH_ANYTHING_SIDES,
  },
  {
    id: 'depth-anything-v2-base',
    model: 'onnx-community/depth-anything-v2-base',
    name: { tr: 'Depth Anything V2 Base (yüksek kalite)', en: 'Depth Anything V2 Base (high quality)' },
    description: {
      tr: 'Daha büyük model (~98M parametre): daha tutarlı ve ayrıntılı derinlik; karşılığında indirme daha büyük, çıkarım daha yavaş. '
        + 'WebGPU önerilir. Lisans: CC-BY-NC-4.0 (yalnızca ticari olmayan kullanım).',
      en: 'Larger model (~98M parameters): more consistent, more detailed depth, at the cost of a bigger download and slower inference. '
        + 'WebGPU recommended. License: CC-BY-NC-4.0 (non-commercial use only).',
    },
    downloadSizeMB: 195,
    convention: 'disparity',
    nativeSide: 518,
    patchMultiple: 14,
    detailSides: DEPTH_ANYTHING_SIDES,
  },
  {
    id: 'dpt-hybrid-midas',
    model: 'Xenova/dpt-hybrid-midas',
    name: { tr: 'DPT Hybrid (MiDaS 3.0)', en: 'DPT Hybrid (MiDaS 3.0)' },
    description: {
      tr: 'Klasik MiDaS v3 hibrit modeli (ResNet-50 + ViT). Sabit 384×384 girişle çalışır; daha yumuşak, sahne ölçeğinde derinlik verir. '
        + 'Karşılaştırma için alternatif; büyük indirme (WASM\'da 8-bit ~125 MB, WebGPU\'da ~490 MB\'a kadar).',
      en: 'Classic MiDaS v3 hybrid model (ResNet-50 + ViT). Runs at a fixed 384×384 input and gives smoother, scene-level depth. '
        + 'An alternative for comparison; large download (~125 MB 8-bit on WASM, up to ~490 MB on WebGPU).',
    },
    downloadSizeMB: 490,
    convention: 'disparity',
    nativeSide: 384,
  },
];

export const ML_DRIVERS: Driver[] = DEPTH_MODEL_SPECS.map(createDepthDriver);
