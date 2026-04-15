/**
 * HTTP helper: fetch with timeout, retry, and a sane User-Agent.
 *
 * Pure HTTP only — no browser. Use this for REST APIs and simple downloads.
 */

import { log } from './log.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const UA = 'Henry/0.1 (+https://github.com/dylanjlennon/henry-slack)';

export interface HttpOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

export async function httpFetch(url: string, opts: HttpOptions = {}): Promise<Response> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, signal, ...init } = opts;
  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason));

    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          accept: 'application/json,text/html,application/xhtml+xml,*/*',
          ...(init.headers ?? {}),
        },
      });
      clearTimeout(timer);
      // Retry on 5xx and 429 only
      if (res.status >= 500 || res.status === 429) {
        if (attempt < retries) {
          await sleep(backoffMs(attempt));
          attempt++;
          continue;
        }
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      log.warn('http_retry', { url, attempt, err: String(err) });
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export async function httpJson<T>(url: string, opts?: HttpOptions): Promise<T> {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 5_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
