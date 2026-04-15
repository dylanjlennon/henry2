/**
 * Orchestrator — runs a set of fetchers in parallel for a resolved property,
 * streams progress events, and aggregates results.
 *
 * Responsibilities:
 *   - Concurrency (REST in parallel, browser gated).
 *   - Per-fetcher timeout.
 *   - Progress multiplexing to the caller.
 *   - Opening a FetcherCall provenance row per fetcher, and closing it
 *     with the final status + summary data when the fetcher returns.
 *   - Updating the Run's running totals as calls finish.
 *
 * Fetchers themselves stay pure: they get `(property, outDir, onProgress,
 * signal, run)` and return a FetcherResult. The orchestrator owns the
 * provenance lifecycle so fetchers don't have to.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CanonicalProperty,
  Fetcher,
  FetcherResult,
  ProgressEvent,
  RunContext,
} from '../types.ts';
import { log } from '../lib/log.ts';
import type { ProvenanceRecorder } from '../provenance/recorder.ts';
import type { FetcherCall } from '../provenance/schema.ts';

export interface RunOptions {
  /** Output directory — fetchers write their files into sub-paths of this */
  outRoot: string;
  /** Only run fetchers whose id is in this list (default: all) */
  only?: string[];
  /** Exclude fetchers by id (default: none) */
  exclude?: string[];
  /** Max concurrent browser-based fetchers (default: 2) */
  browserConcurrency?: number;
  /** Per-fetcher timeout in ms (default: 120_000) */
  fetcherTimeoutMs?: number;
  /** Progress callback */
  onProgress?: (event: ProgressEvent) => void;
  /** Abort signal to cancel all fetchers */
  signal?: AbortSignal;
  /** Provenance recorder — created by the caller (Slack handler / API / CLI). */
  recorder: ProvenanceRecorder;
}

export interface RunSummary {
  runId: string;
  property: CanonicalProperty;
  outDir: string;
  results: FetcherResult[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  totals: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    filesProduced: number;
  };
}

export async function runFetchers(
  fetchers: Fetcher[],
  property: CanonicalProperty,
  opts: RunOptions,
): Promise<RunSummary> {
  const startedAt = new Date();
  const runId = opts.recorder.runId;
  const outDir = join(opts.outRoot, runId);
  await mkdir(outDir, { recursive: true });

  const active = filterFetchers(fetchers, property, opts);
  const runLog = log.child({ runId, pin: property.pin });
  runLog.info('run_started', { fetchers: active.map((f) => f.id) });
  await opts.recorder.setFetchersPlanned(active.length);

  opts.onProgress?.({
    fetcher: 'orchestrator',
    status: 'started',
    message: `Running ${active.length} fetchers for ${property.pin}`,
  });

  // Split into REST (full parallel) and browser (concurrency-limited) buckets
  const rest = active.filter((f) => !f.needsBrowser);
  const browser = active.filter((f) => f.needsBrowser);
  const browserLimit = opts.browserConcurrency ?? 2;
  const fetcherTimeout = opts.fetcherTimeoutMs ?? 120_000;

  const runOne = (f: Fetcher) => runOneFetcher(f, property, outDir, opts, fetcherTimeout);

  const results = await Promise.all([
    ...rest.map(runOne),
    ...(await runWithLimit(browser, runOne, browserLimit)),
  ]);

  const finishedAt = new Date();
  const totals = {
    total: results.length,
    completed: results.filter((r) => r.status === 'completed').length,
    failed: results.filter((r) => r.status === 'failed').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    filesProduced: results.reduce((n, r) => n + r.files.length, 0),
  };

  const summary: RunSummary = {
    runId,
    property,
    outDir,
    results,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    totals,
  };

  opts.onProgress?.({
    fetcher: 'orchestrator',
    status: 'completed',
    message: `Done: ${totals.completed}/${totals.total} succeeded, ${totals.filesProduced} files`,
  });
  runLog.info('run_finished', { totals, durationMs: summary.durationMs });
  return summary;
}

async function runOneFetcher(
  f: Fetcher,
  property: CanonicalProperty,
  outDir: string,
  opts: RunOptions,
  timeoutMs: number,
): Promise<FetcherResult> {
  const t0 = Date.now();
  // Open the provenance call BEFORE running, so HTTP hits can reference it.
  const call = await opts.recorder.startFetcherCall(f.id, fetcherVersion(f));
  const run: RunContext = {
    runId: opts.recorder.runId,
    fetcherCallId: call.id,
    recorder: opts.recorder,
  };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('fetcher timeout')), timeoutMs);
    if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(opts.signal!.reason));
    try {
      const result = await f.run({
        property,
        outDir,
        onProgress: opts.onProgress,
        signal: ac.signal,
        run,
      });
      await closeCall(opts.recorder, call, {
        status: toCallStatus(result.status),
        error: result.error ?? null,
        data: result.data ?? null,
      });
      return result;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onProgress?.({ fetcher: f.id, status: 'failed', error: msg });
    await closeCall(opts.recorder, call, { status: 'failed', error: msg, data: null });
    return { fetcher: f.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
  }
}

async function closeCall(
  recorder: ProvenanceRecorder,
  call: FetcherCall,
  finish: {
    status: 'completed' | 'failed' | 'skipped' | 'timeout';
    error: string | null;
    data: Record<string, unknown> | null;
  },
): Promise<void> {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - Date.parse(call.startedAt);
  await recorder.finishFetcherCall({
    ...call,
    status: finish.status,
    error: finish.error,
    data: finish.data,
    finishedAt: finishedAt.toISOString(),
    durationMs,
  });
}

function toCallStatus(s: FetcherResult['status']): 'completed' | 'failed' | 'skipped' {
  return s;
}

function fetcherVersion(f: Fetcher): string {
  // Fetchers may declare a `version` in the future; fall back to Henry version.
  return (f as unknown as { version?: string }).version ?? '0.1.0';
}

function filterFetchers(
  all: Fetcher[],
  property: CanonicalProperty,
  opts: RunOptions,
): Fetcher[] {
  return all.filter((f) => {
    if (!f.counties.includes(property.county)) return false;
    if (opts.only && !opts.only.includes(f.id)) return false;
    if (opts.exclude && opts.exclude.includes(f.id)) return false;
    return true;
  });
}

async function runWithLimit<T, U>(
  items: T[],
  worker: (item: T) => Promise<U>,
  limit: number,
): Promise<Promise<U>[]> {
  const inFlight: Promise<U>[] = [];
  const active: Promise<unknown>[] = [];
  for (const item of items) {
    const p = worker(item);
    inFlight.push(p);
    active.push(p);
    if (active.length >= limit) {
      await Promise.race(active);
      for (let i = active.length - 1; i >= 0; i--) {
        const s = await Promise.race([active[i], Promise.resolve('__pending__')]);
        if (s !== '__pending__') active.splice(i, 1);
      }
    }
  }
  return inFlight;
}
