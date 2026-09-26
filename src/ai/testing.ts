/**
 * Test-only helpers for the AI module: a scripted fetch and tiny fixtures.
 * Imported by *.test.ts files only (never by app code).
 */
import { base64ToBytes } from './encode';

export interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
  /** Parsed JSON body (string bodies that parse). */
  json?: unknown;
  /** FormData body. */
  form?: FormData;
}

export type Reply = Response | Error | ((call: Call) => Response | Error | Promise<Response>);

interface Route {
  method: string | null;
  match: RegExp | string;
  replies: Reply[];
}

/** A scripted network: routes are matched in registration order; a route's replies are served in turn (the last one repeats). */
export function fakeNet() {
  const routes: Route[] = [];
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init.method ?? 'GET').toUpperCase();
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const call: Call = { url, method, headers: new Headers(init.headers), body: init.body };
    if (typeof init.body === 'string') {
      try {
        call.json = JSON.parse(init.body);
      } catch {
        // not JSON
      }
    } else if (init.body instanceof FormData) {
      call.form = init.body;
    }
    calls.push(call);
    const route = routes.find((r) => (!r.method || r.method === method) && (typeof r.match === 'string' ? url === r.match : r.match.test(url)));
    if (!route) throw new TypeError(`fakeNet: no route for ${method} ${url}`);
    const reply = route.replies.length > 1 ? route.replies.shift()! : route.replies[0];
    const r = typeof reply === 'function' ? await reply(call) : reply;
    if (r instanceof Error) throw r;
    return r.clone();
  };
  return {
    fetch,
    calls,
    on(method: string | null, match: RegExp | string, ...replies: Reply[]) {
      routes.push({ method: method?.toUpperCase() ?? null, match, replies });
      return this;
    },
  };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** 1×1 transparent PNG. */
export const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function pngBlob(): Blob {
  return new Blob([base64ToBytes(PNG_BASE64) as BlobPart], { type: 'image/png' });
}

export function glbBytes(size = 64): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(size);
  const v = new DataView(b.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, size, true);
  return b;
}

export const binary = (bytes: Uint8Array<ArrayBuffer>, type: string) => new Response(new Blob([bytes], { type }), { status: 200, headers: { 'content-type': type } });
