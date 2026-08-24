import { CapacitorHttp } from '@capacitor/core';

/**
 * The phone's transport.
 *
 * Kalshi rejects any request carrying an `Origin` header — with a 403,
 * whatever the value, and regardless of User-Agent. A WebView `fetch()`
 * always attaches one on a cross-origin call, so the browser networking stack
 * simply cannot reach that API. That is not a CORS misconfiguration to work
 * around with a proxy; it is why this app has to exist as a native shell
 * rather than a web page.
 *
 * `CapacitorHttp` performs the request in Java, which sends no Origin. Every
 * adapter and service takes its transport as an argument, so they are handed
 * this and are otherwise untouched — the same code the desktop runs.
 *
 * It also lets requests set headers a WebView forbids. ESPN rejects browser
 * User-Agent strings, and `fetch` will not let a page change its own.
 */

const REQUEST_TIMEOUT_MS = 12_000;

/**
 * Give a promise a deadline it cannot outlive.
 *
 * `CapacitorHttp` resolves through the native bridge, and a bridge that is
 * missing or wedged leaves the promise pending forever rather than
 * rejecting — which surfaces as a screen stuck on "Loading…" with no way
 * back. A phone on a flaky connection produces the same symptom. Every
 * network path here therefore carries its own deadline.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export const nativeFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  // Headers the caller set — ESPN's User-Agent above all — have to survive
  // the hop into the native layer, or the request arrives as something the
  // feed refuses.
  const headers: Record<string, string> = { accept: 'application/json' };
  const supplied = init?.headers;
  if (supplied) {
    if (supplied instanceof Headers) supplied.forEach((v, k) => (headers[k] = v));
    else if (Array.isArray(supplied)) for (const [k, v] of supplied) headers[k] = v;
    else Object.assign(headers, supplied);
  }

  const response = await withDeadline(
    CapacitorHttp.request({
      url,
      method: (init?.method ?? 'GET') as 'GET',
      headers,
      // Ask for the parsed body; Capacitor hands back an object for JSON.
      responseType: 'json',
      connectTimeout: REQUEST_TIMEOUT_MS,
      readTimeout: REQUEST_TIMEOUT_MS,
      ...(init?.body ? { data: init.body } : {}),
    }),
    REQUEST_TIMEOUT_MS,
    'Request',
  );

  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);
  return new Response(body, {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
};
