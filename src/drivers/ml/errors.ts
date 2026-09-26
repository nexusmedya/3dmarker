/**
 * Turns low-level ML worker failures (fetch errors from transformers.js /
 * ONNX Runtime, missing weight files) into bilingual messages the UI can show.
 */
import { LocalizedError } from '../../core/errors';

/**
 * Browser fetch failures: Chromium, Firefox, Safari wording (+ ORT's dynamic
 * import of its wasm loader: "Failed to fetch dynamically imported module" /
 * "error loading dynamically imported module" / "Importing a module script failed").
 */
const NETWORK_RE =
  /failed to fetch|networkerror|network error|load failed|fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|err_internet_disconnected|err_name_not_resolved/i;

export function isNetworkError(e: unknown): boolean {
  return e instanceof Error && NETWORK_RE.test(e.message);
}

/** Map a failure of an ML request for `model` to a LocalizedError; aborts and unknown errors pass through. */
export function localizeMlError(e: unknown, model: string): unknown {
  if (!(e instanceof Error) || e.name === 'AbortError' || e instanceof LocalizedError) return e;
  const detail = e.message.length > 160 ? `${e.message.slice(0, 157)}…` : e.message;
  if (isNetworkError(e)) {
    return new LocalizedError({
      tr: `Yapay zekâ modeli (${model}) indirilemedi: Hugging Face'e veya ONNX Runtime dosyalarına ulaşılamıyor. İnternet bağlantınızı kontrol edin ya da çevrimdışı çalışan sezgisel bir sürücü (ör. Siluet şişirme) seçin. [${detail}]`,
      en: `Could not download the AI model (${model}): Hugging Face or the ONNX Runtime files are unreachable. Check your internet connection, or pick an offline heuristic driver (e.g. Silhouette inflate). [${detail}]`,
    });
  }
  if (e.name === 'ModelFileNotFoundError') {
    return new LocalizedError({
      tr: `Model dosyaları Hugging Face'te bulunamadı (${model}). [${detail}]`,
      en: `Model files were not found on Hugging Face (${model}). [${detail}]`,
    });
  }
  return e;
}
