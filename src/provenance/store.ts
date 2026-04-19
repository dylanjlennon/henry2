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

  /** Web-UI-specific queries — implemented by Postgres store, stubbed in memory store. */
  getWebRunStatus(runId: string): Promise<WebRunStatus | null>;
  listWebRuns(opts?: { limit?: number; cursor?: string }): Promise<WebRunRow[]>;
  countRecentWebRunsByIp(ipHash: string, sinceMs: number): Promise<number>;
  countRecentEmailRunsBySender(senderHash: string, sinceMs: number): Promise<number>;
}

/** Compact status object for the web UI polling endpoint. */
export interface WebRunStatus {
  runId: string;
  status: 'running' | 'completed' | 'partial' | 'failed';
  pin: string;
  address: string | null;
  ownerName: string | null;
  fetchersPlanned: number;
  fetchersCompleted: number;
  fetchersFailed: number;
  startedAt: string;
  durationMs: number | null;
  artifacts: Array<{
    id: string;
    label: string;
    contentType: string;
    bytes: number;
  }>;
  fetcherStatuses: Record<string, string>;
  /** Structured data from each completed fetcher (fetcherId → data object) */
  fetcherData: Record<string, Record<string, unknown>>;
}

/** One row in the public history list. */
export interface WebRunRow {
  runId: string;
  address: string | null;
  pin: string;
  status: string;
  fetchersCompleted: number;
  fetchersPlanned: number;
  artifactsProduced: number;
  durationMs: number | null;
  startedAt: string;
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
