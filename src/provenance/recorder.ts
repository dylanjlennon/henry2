/**
 * ProvenanceRecorder — the live, per-run object that instrumented code
 * talks to. Every HTTP call, fetcher lifecycle event, and artifact write
 * funnels through here and lands as an immutable record in the
 * ProvenanceStore.
 *
 * Lifecycle:
 *
 *   const rec = new ProvenanceRecorder({ store, artifactStore, invocation });
 *   await rec.saveInvocation();
 *   await rec.startRun(propertySnapshot);
 *   const call = await rec.startFetcherCall('parcel-json', '0.1.0');
 *   // ... fetcher runs; HTTP calls flow through rec.recordHttpHit(...)
 *   await rec.finishFetcherCall({ ...call, status: 'completed', data, ... });
 *   const artifact = await rec.putArtifact({ fetcherCallId: call.id, ... });
 *   await rec.finishRun({ status: 'completed' });
 *
 * The recorder is deliberately dumb: it persists what it's told, in order,
 * and tracks a handful of running totals. It does not decide policy
 * (retries, timeouts, etc.) — those live in the callers.
 */

import { randomUUID, createHash } from 'node:crypto';
import type {
  Artifact,
  FetcherCall,
  HttpHit,
  Invocation,
  PropertySnapshot,
  Run,
} from './schema.js';
import { HENRY_VERSION } from './schema.js';
import type { ArtifactStore, ProvenanceStore } from './store.js';

export interface RecorderOptions {
  store: ProvenanceStore;
  artifactStore: ArtifactStore;
  invocation: Invocation;
  runId?: string;
  now?: () => Date;
}

export interface PutArtifactInput {
  fetcherCallId: string;
  label: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
  sourceUrl?: string | null;
}

export class ProvenanceRecorder {
  readonly runId: string;
  readonly invocation: Invocation;

  private readonly store: ProvenanceStore;
  private readonly artifactStore: ArtifactStore;
  private readonly now: () => Date;

  private run: Run | null = null;
  private readonly artifactLog: Artifact[] = [];
  private totals = {
    fetchersTotal: 0,
    fetchersCompleted: 0,
    fetchersFailed: 0,
    fetchersSkipped: 0,
    artifactsProduced: 0,
    httpHits: 0,
  };

  constructor(opts: RecorderOptions) {
    this.store = opts.store;
    this.artifactStore = opts.artifactStore;
    this.invocation = opts.invocation;
    this.runId = opts.runId ?? randomUUID();
    this.now = opts.now ?? (() => new Date());
  }

  /** Persist the originating invocation. Call once, before startRun. */
  async saveInvocation(): Promise<void> {
    await this.store.saveInvocation(this.invocation);
  }

  async startRun(property: PropertySnapshot): Promise<Run> {
    const startedAt = this.now();
    this.run = {
      id: this.runId,
      invocationId: this.invocation.id,
      henryVersion: HENRY_VERSION,
      property,
      status: 'running',
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      durationMs: null,
      totals: { ...this.totals },
    };
    await this.store.saveRun(this.run);
    return this.run;
  }

  async setFetchersPlanned(n: number): Promise<void> {
    if (!this.run) throw new Error('Run not started');
    this.totals.fetchersTotal = n;
    this.run = { ...this.run, totals: { ...this.totals } };
    await this.store.updateRun(this.run);
  }

  async finishRun(opts: { status: 'completed' | 'partial' | 'failed' }): Promise<Run> {
    if (!this.run) throw new Error('Run not started');
    const finishedAt = this.now();
    const startedMs = Date.parse(this.run.startedAt);
    this.run = {
      ...this.run,
      status: opts.status,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedMs,
      totals: { ...this.totals },
    };
    await this.store.updateRun(this.run);
    return this.run;
  }

  async startFetcherCall(fetcherId: string, fetcherVersion: string): Promise<FetcherCall> {
    const call: FetcherCall = {
      id: randomUUID(),
      runId: this.runId,
      fetcherId,
      fetcherVersion,
      status: 'pending',
      startedAt: this.now().toISOString(),
      finishedAt: null,
      durationMs: null,
      error: null,
      data: null,
    };
    await this.store.saveFetcherCall(call);
    return call;
  }

  /** Finish a fetcher call with the full updated record. */
  async finishFetcherCall(call: FetcherCall): Promise<void> {
    await this.store.updateFetcherCall(call);
    if (call.status === 'completed') this.totals.fetchersCompleted++;
    else if (call.status === 'failed' || call.status === 'timeout') this.totals.fetchersFailed++;
    else if (call.status === 'skipped') this.totals.fetchersSkipped++;
  }

  async recordHttpHit(hit: HttpHit): Promise<void> {
    await this.store.saveHttpHit(hit);
    this.totals.httpHits++;
  }

  /** Persist bytes to the artifact store and the metadata row. */
  async putArtifact(input: PutArtifactInput): Promise<Artifact> {
    const { storageUri, sha256, bytes } = await this.artifactStore.put({
      runId: this.runId,
      filename: input.filename,
      contentType: input.contentType,
      bytes: input.bytes,
    });
    const artifact: Artifact = {
      id: randomUUID(),
      runId: this.runId,
      fetcherCallId: input.fetcherCallId,
      label: input.label,
      contentType: input.contentType,
      bytes,
      sha256,
      sourceUrl: input.sourceUrl ?? null,
      storageUri,
      createdAt: this.now().toISOString(),
    };
    await this.store.saveArtifact(artifact);
    this.totals.artifactsProduced++;
    this.artifactLog.push(artifact);
    return artifact;
  }

  /** All artifacts written during this recorder's lifetime. */
  get artifacts(): readonly Artifact[] {
    return this.artifactLog;
  }

  /** A fresh HTTP hit id (UUID). Exposed so callers can link request/response logs. */
  newHttpHitId(): string {
    return randomUUID();
  }
}

/**
 * Compute a deterministic request hash for dedupe:
 *
 *     sha256(`${METHOD} ${url}\n${sorted lowercased headers}\n${body?}`)
 *
 * The `authorization` header is excluded so credential rotation doesn't
 * invalidate dedupe.
 */
export function computeRequestHash(input: {
  method: string;
  url: string;
  headers?: Record<string, string> | Headers;
  body?: string | Buffer | null;
}): string {
  const h = createHash('sha256');
  h.update(`${input.method.toUpperCase()} ${input.url}\n`);
  const hdrs = normalizeHeaders(input.headers);
  const keys = Object.keys(hdrs).sort();
  for (const k of keys) {
    if (k === 'authorization') continue;
    h.update(`${k}: ${hdrs[k]}\n`);
  }
  if (input.body != null) {
    h.update('\n');
    h.update(typeof input.body === 'string' ? input.body : input.body);
  }
  return h.digest('hex');
}

/** SHA-256 of a buffer, as lowercase hex. */
export function sha256Hex(bytes: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function normalizeHeaders(
  h: Record<string, string> | Headers | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}
