/**
 * Orchestrator — runs a set of fetchers in parallel for a resolved property,
 * streams progress events, and aggregates results.
 *
 * Design:
 *   - Fetchers are pure: they receive (property, outDir, onProgress) and
 *     return a FetcherResult. No shared state between fetchers.
 *   - The orchestrator handles concurrency, per-fetcher timeouts, progress
 *     multiplexing, and overall job state.
 *   - REST fetchers run fully in parallel. Browser fetchers are gated by a
 *     small concurrency limit so we don't exhaust Playwright resources.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  CanonicalProperty,
  Fetcher,
  FetcherResult,
  ProgressEvent,
} from '../types.ts';
import { log } from '../lib/log.ts';

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
  const runId = makeRunId(property, startedAt);
  const outDir = join(opts.outRoot, runId);
  await mkdir(outDir, { recursive: true });

  const active = filterFetchers(fetchers, property, opts);
  log.info('run_started', { runId, pin: property.pin, fetchers: active.map((f) => f.id) });

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
  log.info('run_finished', { runId, totals, durationMs: summary.durationMs });
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
  try {
    // Per-fetcher timeout wrapping
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('fetcher timeout')), timeoutMs);
    if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(opts.signal!.reason));
    try {
      return await f.run({
        property,
        outDir,
        onProgress: opts.onProgress,
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.onProgress?.({ fetcher: f.id, status: 'failed', error: msg });
    return { fetcher: f.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
  }
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
  // Returns an array of in-flight promises; caller awaits Promise.all.
  const inFlight: Promise<U>[] = [];
  const active: Promise<unknown>[] = [];
  for (const item of items) {
    const p = worker(item);
    inFlight.push(p);
    active.push(p);
    if (active.length >= limit) {
      await Promise.race(active);
      // Remove settled promises
      for (let i = active.length - 1; i >= 0; i--) {
        const s = await Promise.race([active[i], Promise.resolve('__pending__')]);
        if (s !== '__pending__') active.splice(i, 1);
      }
    }
  }
  return inFlight;
}

function makeRunId(property: CanonicalProperty, now: Date): string {
  const ts = now.toISOString().replace(/[:.]/g, '-');
  return `${property.gisPin}-${ts}`;
}
