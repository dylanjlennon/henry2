/**
 * HTTP helper: fetch with timeout, retry, and a sane User-Agent.
 *
 * When a ProvenanceRecorder is attached via `opts.recorder`, every attempt
 * — successful or not — is recorded as an `HttpHit` row. That gives us the
 * full, replayable audit trail: the exact URL, when it was hit, the
 * response code, the SHA-256 of the body, and how long it took.
 *
 * Pure HTTP only — no browser. Use this for REST APIs and simple downloads.
 */

import { randomUUID } from 'node:crypto';
import { log } from './log.ts';
import { computeRequestHash, sha256Hex } from '../provenance/recorder.ts';
import type { ProvenanceRecorder } from '../provenance/recorder.ts';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;
const UA = 'Henry/0.1 (+https://github.com/dylanjlennon/henry-slack)';

export interface HttpOptions extends Omit<RequestInit, 'signal'> {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
  /** Provenance recorder. When present, every attempt is logged. */
  recorder?: ProvenanceRecorder;
  /** Fetcher call id this HTTP hit belongs to (null for orchestrator-level hits). */
  fetcherCallId?: string | null;
  /**
   * Per-host source classification, e.g. "buncombe.gis", "fema.nfhl".
   * Stored on every HttpHit for easy filtering in dashboards.
   */
  sourceLabel?: string;
}

/**
 * Fetch-with-provenance. Returns a Response with an extra `__httpHitId`
 * attached so callers that need to bind a response digest to a specific
 * hit row (e.g. after reading the body) can do so.
 */
export async function httpFetch(
  url: string,
  opts: HttpOptions = {},
): Promise<Response & { __httpHitId?: string }> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    signal,
    recorder,
    fetcherCallId = null,
    sourceLabel = classifyUrl(url),
    ...init
  } = opts;

  const method = (init.method ?? 'GET').toUpperCase();
  const requestHash = computeRequestHash({
    method,
    url,
    headers: init.headers as Record<string, string> | undefined,
    body: typeof init.body === 'string' ? init.body : null,
  });

  let attempt = 0;
  let lastErr: unknown;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    if (signal) signal.addEventListener('abort', () => controller.abort(signal.reason));

    const hitId = recorder ? randomUUID() : undefined;
    const startedAt = new Date();

    try {
      const res = await fetch(url, {
        ...init,
        method,
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          accept: 'application/json,text/html,application/xhtml+xml,*/*',
          ...(init.headers ?? {}),
        },
      });
      clearTimeout(timer);

      // Retry on 5xx and 429 only. Record the failed attempt before retrying.
      const shouldRetry = (res.status >= 500 || res.status === 429) && attempt < retries;
      if (shouldRetry) {
        if (recorder && hitId) {
          await recorder.recordHttpHit({
            id: hitId,
            runId: recorder.runId,
            fetcherCallId,
            method,
            url,
            requestHash,
            sourceLabel,
            status: res.status,
            responseBytes: null,
            responseSha256: null,
            responseContentType: res.headers.get('content-type') ?? null,
            startedAt: startedAt.toISOString(),
            finishedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt.getTime(),
            error: `HTTP ${res.status} (retriable)`,
            attempt,
          });
        }
        log.warn('http_retry_status', { url, status: res.status, attempt });
        await sleep(backoffMs(attempt));
        attempt++;
        continue;
      }

      // Non-retriable response — tag it for later body-digest recording.
      const tagged = res as Response & { __httpHitId?: string };
      if (recorder && hitId) {
        tagged.__httpHitId = hitId;
        // We hand off a function the caller can invoke after reading the body.
        // This avoids double-reading the stream here.
        attachBodyRecorder(tagged, {
          recorder,
          hitId,
          runId: recorder.runId,
          fetcherCallId,
          method,
          url,
          requestHash,
          sourceLabel,
          status: res.status,
          contentType: res.headers.get('content-type') ?? null,
          startedAt,
          attempt,
        });
      }
      return tagged;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      log.warn('http_retry', { url, attempt, err: String(err) });
      if (recorder && hitId) {
        await recorder.recordHttpHit({
          id: hitId,
          runId: recorder.runId,
          fetcherCallId,
          method,
          url,
          requestHash,
          sourceLabel,
          status: null,
          responseBytes: null,
          responseSha256: null,
          responseContentType: null,
          startedAt: startedAt.toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedAt.getTime(),
          error: String(err),
          attempt,
        });
      }
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
  if (!res.ok) {
    await finalizeHit(res, { bytes: 0, sha256: null });
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }
  const text = await res.text();
  const buf = Buffer.from(text, 'utf8');
  await finalizeHit(res, { bytes: buf.byteLength, sha256: sha256Hex(buf) });
  return JSON.parse(text) as T;
}

/**
 * Read the response body as a Buffer and finalize the HTTP hit with the
 * exact bytes / sha256. Preferred over manual `res.arrayBuffer()` in
 * instrumented code because it guarantees the hit row gets closed out.
 */
export async function httpBuffer(url: string, opts?: HttpOptions): Promise<Buffer> {
  const res = await httpFetch(url, opts);
  const buf = Buffer.from(await res.arrayBuffer());
  await finalizeHit(res, {
    bytes: buf.byteLength,
    sha256: res.ok ? sha256Hex(buf) : null,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return buf;
}

/** Finish recording an HTTP hit with the response body digest. Safe to call twice (no-op the second time). */
export async function finalizeHit(
  res: Response & { __httpHitId?: string },
  body: { bytes: number; sha256: string | null },
): Promise<void> {
  const finalize = (res as Response & { __finalize?: (b: typeof body) => Promise<void> }).__finalize;
  if (finalize) {
    delete (res as Response & { __finalize?: unknown }).__finalize;
    await finalize(body);
  }
}

interface PendingHitContext {
  recorder: ProvenanceRecorder;
  hitId: string;
  runId: string;
  fetcherCallId: string | null;
  method: string;
  url: string;
  requestHash: string;
  sourceLabel: string;
  status: number;
  contentType: string | null;
  startedAt: Date;
  attempt: number;
}

function attachBodyRecorder(res: Response, ctx: PendingHitContext): void {
  const target = res as Response & { __finalize?: (b: { bytes: number; sha256: string | null }) => Promise<void> };
  target.__finalize = async (body) => {
    await ctx.recorder.recordHttpHit({
      id: ctx.hitId,
      runId: ctx.runId,
      fetcherCallId: ctx.fetcherCallId,
      method: ctx.method,
      url: ctx.url,
      requestHash: ctx.requestHash,
      sourceLabel: ctx.sourceLabel,
      status: ctx.status,
      responseBytes: body.bytes,
      responseSha256: body.sha256,
      responseContentType: ctx.contentType,
      startedAt: ctx.startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - ctx.startedAt.getTime(),
      error: null,
      attempt: ctx.attempt,
    });
  };
}

/**
 * Heuristic per-host source labeling. Keeps provenance queries simple:
 *
 *     SELECT source_label, COUNT(*) FROM http_hits GROUP BY 1;
 *
 * When a caller wants precise control, they pass sourceLabel explicitly.
 */
function classifyUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('buncombecounty')) return 'buncombe';
    if (host.includes('fema.gov')) return 'fema';
    if (host.includes('arcgis.com')) return 'arcgis';
    if (host.includes('usps.com')) return 'usps';
    if (host.includes('slack.com')) return 'slack';
    return host;
  } catch {
    return 'unknown';
  }
}

function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 5_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
