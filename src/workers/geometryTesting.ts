/**
 * Test helpers: an in-process stand-in for the geometry worker. Messages
 * cross a structuredClone with the same transfer lists (so a transferred
 * buffer is detached on the sending side, as in a browser) and arrive in a
 * later macrotask, like postMessage.
 */
import { GeometryHost } from './geometryHost';
import type { GeometryWorkerLike } from './geometryClient';
import type { GeometryRequest, GeometryResponse } from './geometryProtocol';

export interface FakeWorkerOptions {
  /** Fail like a module worker the browser cannot run: an error event and no 'ready'. */
  failToStart?: boolean;
}

export class FakeGeometryWorker implements GeometryWorkerLike {
  onmessage: ((e: MessageEvent<GeometryResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  terminated = false;
  readonly host: GeometryHost;
  /** Every request the client posted (after cloning). */
  readonly sent: GeometryRequest[] = [];

  constructor(o: FakeWorkerOptions = {}) {
    this.host = new GeometryHost((msg, transfer = []) => {
      const m = structuredClone(msg, { transfer });
      setTimeout(() => this.deliver(m));
    });
    setTimeout(() => {
      if (o.failToStart) this.fail('SyntaxError: Cannot use import statement outside a module');
      else this.deliver({ type: 'ready' });
    });
  }

  postMessage(msg: GeometryRequest, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    const m = structuredClone(msg, { transfer });
    this.sent.push(m);
    setTimeout(() => {
      if (!this.terminated) this.host.handle(m);
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Raise a worker error event (a crash, or a script that failed to load). */
  fail(message = 'crash'): void {
    if (this.terminated) return;
    this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }

  private deliver(m: GeometryResponse): void {
    if (!this.terminated) this.onmessage?.({ data: m } as MessageEvent<GeometryResponse>);
  }
}
