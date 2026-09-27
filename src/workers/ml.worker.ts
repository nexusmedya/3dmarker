/**
 * Module Web Worker hosting transformers.js pipelines ('depth-estimation',
 * 'background-removal', 'image-to-image' super-resolution). Message glue only: device/dtype selection, caching
 * and queueing live in mlEngine.ts, transformers.js calls in mlTasks.ts and
 * the protocol in mlProtocol.ts.
 *
 * Created by src/drivers/ml/workerClient.ts with
 * `new Worker(new URL('../../workers/ml.worker.ts', import.meta.url), { type: 'module' })`.
 */
import type { BackgroundRemovalPipeline, DepthEstimationPipeline, ImageToImagePipeline } from '@huggingface/transformers';
import { detectGpu, MlEngine, SerialQueue, type GpuLike } from './mlEngine';
import { serializeError, type MlJob, type MlProgress, type MlRequest, type MlResponse, type MlResult, type MlTask } from './mlProtocol';
import { configureEnv, initEnv, loadPipeline, runBackgroundRemoval, runDepth, runUpscale, type AnyPipeline } from './mlTasks';

/** MlResult before the engine reports which device/dtype actually ran. */
type WithoutDevice<T> = T extends unknown ? Omit<T, 'device' | 'dtype'> : never;
type RawResult = WithoutDevice<MlResult>;

// The tsconfig uses the DOM lib, so describe the worker scope we use.
interface WorkerScope {
  postMessage(message: MlResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<MlRequest>) => void): void;
}
const scope = self as unknown as WorkerScope;

initEnv();
const engine = new MlEngine<AnyPipeline>({
  load: loadPipeline,
  dispose: (p) => p.dispose(),
  detectGpu: () => detectGpu((navigator as unknown as { gpu?: GpuLike }).gpu),
});
const queue = new SerialQueue();
/** Jobs running now; a 'cancel' for one of them stops a tiled job between tiles. */
const running = new Set<number>();
const cancelled = new Set<number>();

const TASKS: Record<MlJob['type'], MlTask> = {
  depth: 'depth-estimation',
  'background-removal': 'background-removal',
  upscale: 'image-to-image',
};

function post(msg: MlResponse, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

async function handleJob(job: MlJob): Promise<void> {
  const emit = (p: MlProgress) => post({ type: 'progress', id: job.id, ...p });
  const spec = {
    task: TASKS[job.type],
    model: job.model,
    device: job.device,
    precision: job.precision,
  };
  try {
    const out = await queue.run(job.id, () => {
      running.add(job.id);
      return engine.run(spec, emit, async (pipe, device): Promise<RawResult> => {
        switch (job.type) {
          case 'depth':
            return { kind: 'depth', ...(await runDepth(pipe as DepthEstimationPipeline, job)) };
          case 'background-removal':
            return { kind: 'alpha', ...(await runBackgroundRemoval(pipe as BackgroundRemovalPipeline, job)) };
          case 'upscale':
            emit({ stage: 'inference', device, done: 0 });
            return {
              kind: 'image',
              ...(await runUpscale(pipe as ImageToImagePipeline, job, device, {
                onTile: (done, total) => emit({ stage: 'inference', device, done, total }),
                isCancelled: () => cancelled.has(job.id),
              })),
            };
        }
      });
    });
    if (!out) return; // cancelled while queued; the client has already given up
    const result = { ...out.result, device: out.device, dtype: out.dtype } as MlResult;
    post({ type: 'result', id: job.id, result }, [result.data.buffer as ArrayBuffer]);
  } catch (e) {
    post({ type: 'error', id: job.id, error: serializeError(e) });
  } finally {
    running.delete(job.id);
    cancelled.delete(job.id);
  }
}

scope.addEventListener('message', (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'configure':
      configureEnv(msg.config);
      break;
    case 'cancel':
      queue.cancel(msg.id);
      if (running.has(msg.id)) cancelled.add(msg.id);
      break;
    case 'dispose':
      void queue.run(null, () => engine.disposeAll());
      break;
    case 'depth':
    case 'background-removal':
    case 'upscale':
      void handleJob(msg);
      break;
  }
});
