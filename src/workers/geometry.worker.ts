/**
 * Module Web Worker for the heavy geometry work: multi-view fusion and rig
 * skin weights. Message glue only; the logic is in ./geometryHost.ts, the
 * protocol in ./geometryProtocol.ts and the main-thread side in
 * ./geometryClient.ts, which creates it with
 * `new Worker(new URL('./geometry.worker.ts', import.meta.url), { type: 'module' })`.
 */
import { GeometryHost } from './geometryHost';
import type { GeometryRequest, GeometryResponse } from './geometryProtocol';

// The tsconfig uses the DOM lib, so describe the worker scope we use.
interface WorkerScope {
  postMessage(message: GeometryResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: MessageEvent<GeometryRequest>) => void): void;
}
const scope = self as unknown as WorkerScope;

const host = new GeometryHost((msg, transfer = []) => scope.postMessage(msg, transfer));
scope.addEventListener('message', (e) => host.handle(e.data));
scope.postMessage({ type: 'ready' });
