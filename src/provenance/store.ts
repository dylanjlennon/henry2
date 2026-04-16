/**
 * Storage abstractions for provenance records and artifacts.
 *
 * Two stores, two interfaces:
 *   - ProvenanceStore: structured rows (invocations, runs, fetcher calls,
 *     HTTP hits, artifact metadata). Backed by Postgres in prod, by an
 *     in-memory map in tests.
 *   - ArtifactStore: the bytes of each produced file (PDFs, JSON blobs,
 *     screenshots). Backed by a blob store in prod, by the local
 *     filesystem in tests.
 *
 * Swapping backends is a one-line change in the factory at the bottom of
 * this file. Everything else in the codebase talks only to the interfaces.
 */

import type {
  Artifact,
  FetcherCall,
  HttpHit,
  Invocation,
  Run,
  RunTrace,
} from './schema.js';

export interface ProvenanceStore {
  saveInvocation(inv: Invocation): Promise<void>;
  saveRun(run: Run): Promise<void>;
  updateRun(run: Run): Promise<void>;
  saveFetcherCall(call: FetcherCall): Promise<void>;
  updateFetcherCall(call: FetcherCall): Promise<void>;
  saveHttpHit(hit: HttpHit): Promise<void>;
  saveArtifact(artifact: Artifact): Promise<void>;

  getArtifact(id: string): Promise<Artifact | null>;
  getRunTrace(runId: string): Promise<RunTrace | null>;
  listRuns(opts?: { limit?: number; offset?: number }): Promise<Run[]>;
}

export interface ArtifactStore {
  /** Store raw bytes; returns a storage URI (opaque to callers). */
  put(opts: {
    runId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<{ storageUri: string; sha256: string; bytes: number }>;
  /** Retrieve raw bytes given a storage URI. */
  get(storageUri: string): Promise<Buffer>;
  /** Get a publicly-accessible URL for this artifact, if the store supports it. */
  presign?(storageUri: string, opts?: { expiresInSeconds?: number }): Promise<string>;
}
