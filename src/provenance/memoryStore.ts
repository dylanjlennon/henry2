/**
 * In-memory ProvenanceStore + filesystem ArtifactStore.
 *
 * Used for tests and local dev. Same interface as the Postgres + Blob
 * production stores.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type {
  Artifact,
  FetcherCall,
  HttpHit,
  Invocation,
  Run,
  RunTrace,
} from './schema.js';
import type { ProvenanceStore, ArtifactStore, WebRunStatus, WebRunRow } from './store.js';

export class MemoryProvenanceStore implements ProvenanceStore {
  private invocations = new Map<string, Invocation>();
  private runs = new Map<string, Run>();
  private fetcherCalls = new Map<string, FetcherCall>();
  private httpHits = new Map<string, HttpHit>();
  private artifacts = new Map<string, Artifact>();

  async saveInvocation(inv: Invocation): Promise<void> { this.invocations.set(inv.id, inv); }
  async saveRun(run: Run): Promise<void> { this.runs.set(run.id, run); }
  async updateRun(run: Run): Promise<void> { this.runs.set(run.id, run); }
  async saveFetcherCall(call: FetcherCall): Promise<void> { this.fetcherCalls.set(call.id, call); }
  async updateFetcherCall(call: FetcherCall): Promise<void> { this.fetcherCalls.set(call.id, call); }
  async saveHttpHit(hit: HttpHit): Promise<void> { this.httpHits.set(hit.id, hit); }
  async saveArtifact(a: Artifact): Promise<void> { this.artifacts.set(a.id, a); }

  async getArtifact(id: string): Promise<Artifact | null> {
    return this.artifacts.get(id) ?? null;
  }

  async getRunTrace(runId: string): Promise<RunTrace | null> {
    const run = this.runs.get(runId);
    if (!run) return null;
    const invocation = this.invocations.get(run.invocationId);
    if (!invocation) return null;
    return {
      invocation,
      run,
      fetcherCalls: [...this.fetcherCalls.values()].filter((c) => c.runId === runId),
      httpHits: [...this.httpHits.values()].filter((h) => h.runId === runId),
      artifacts: [...this.artifacts.values()].filter((a) => a.runId === runId),
    };
  }

  async listRuns(opts: { limit?: number; offset?: number } = {}): Promise<Run[]> {
    const all = [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return all.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));
  }

  async getWebRunStatus(_runId: string): Promise<WebRunStatus | null> { return null; }
  async listWebRuns(_opts?: { limit?: number; cursor?: string }): Promise<WebRunRow[]> { return []; }
  async countRecentWebRunsByIp(_ipHash: string, _sinceMs: number): Promise<number> { return 0; }
}

/** Filesystem-backed artifact store. Writes to `${root}/${runId}/${filename}`. */
export class FilesystemArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async put(opts: {
    runId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<{ storageUri: string; sha256: string; bytes: number }> {
    const dir = join(this.root, opts.runId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, opts.filename);
    await writeFile(path, opts.bytes);
    const sha256 = createHash('sha256').update(opts.bytes).digest('hex');
    return { storageUri: `file://${path}`, sha256, bytes: opts.bytes.byteLength };
  }

  async get(storageUri: string): Promise<Buffer> {
    const path = storageUri.startsWith('file://') ? storageUri.slice(7) : storageUri;
    return readFile(path);
  }
}
