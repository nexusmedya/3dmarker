/**
 * Module Web Worker hosting transformers.js pipelines ('depth-estimation',
 * 'background-removal'). Message glue only: device/dtype selection, caching
 * and queueing live in mlEngine.ts, transformers.js calls in mlTasks.ts and
 * the protocol in mlProtocol.ts.
 *
 * Created by src/drivers/ml/workerClient.ts with
 * `new Worker(new URL('../../workers/ml.worker.ts', import.meta.url), { type: 'module' })`.
 */
import type { BackgroundRemovalPipeline, DepthEstimationPipeline } from '@huggingface/transformers';
import { MlEngine, SerialQueue, type GpuInfo } from './mlEngine';
import { serializeError, type MlJob, type MlProgress, type MlRequest, type MlResponse, type MlResult } from './mlProtocol';
import { configureEnv, initEnv, loadPipeline, runBackgroundRemoval, runDepth, type AnyPipeline } from './mlTasks';

/** MlResult before the engine reports which device/dtype actually ran. */
type WithoutDevice<T> = T extends unknown ? Omit<T, 'device' | 'dtype'> : never;
type RawResult = WithoutDevice<MlResult>;

// The tsconfig uses the DOM lib, so describe the worker scope we use.
interface WorkerScope {
  postMessage(message: MlResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<MlRequest>) => void): void;
}
const scope = self as unknown as WorkerScope;

async function detectGpu(): Promise<GpuInfo> {
  type Adapter = { features: { has(f: string): boolean } };
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: object): Promise<Adapter | null> } }).gpu;
  if (!gpu) return { available: false, fp16: false };
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  return adapter ? { available: true, fp16: adapter.features.has('shader-f16') } : { available: false, fp16: false };
}

initEnv();
const engine = new MlEngine<AnyPipeline>({ load: loadPipeline, dispose: (p) => p.dispose(), detectGpu });
const queue = new SerialQueue();

function post(msg: MlResponse, transfer: Transferable[] = []): void {
  scope.postMessage(msg, transfer);
}

async function handleJob(job: MlJob): Promise<void> {
  const emit = (p: MlProgress) => post({ type: 'progress', id: job.id, ...p });
  const spec = {
    task: job.type === 'depth' ? ('depth-estimation' as const) : ('background-removal' as const),
    model: job.model,
    device: job.device,
    precision: job.precision,
  };
  try {
    const out = await queue.run(job.id, () =>
      engine.run(spec, emit, async (pipe): Promise<RawResult> =>
        job.type === 'depth'
          ? { kind: 'depth', ...(await runDepth(pipe as DepthEstimationPipeline, job)) }
          : { kind: 'alpha', ...(await runBackgroundRemoval(pipe as BackgroundRemovalPipeline, job)) },
      ),
    );
    if (!out) return; // cancelled while queued; the client has already given up
    const result = { ...out.result, device: out.device, dtype: out.dtype } as MlResult;
    post({ type: 'result', id: job.id, result }, [result.data.buffer as ArrayBuffer]);
  } catch (e) {
    post({ type: 'error', id: job.id, error: serializeError(e) });
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
      break;
    case 'dispose':
      void queue.run(null, () => engine.disposeAll());
      break;
    case 'depth':
    case 'background-removal':
      void handleJob(msg);
      break;
  }
});
