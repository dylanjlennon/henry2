/**
 * Shared types for the Henry property research system.
 *
 * Designed for multi-county use: every county adapter must produce
 * a CanonicalProperty with the same shape so downstream fetchers
 * and the Slack presenter don't care which county the data came from.
 */

export type CountyId = 'buncombe'; // expand as more counties added

export interface ResolverInput {
  /** Raw user input — could be a PIN or an address */
  raw: string;
  county: CountyId;
}

export interface CanonicalProperty {
  county: CountyId;
  /** Display PIN (e.g. "9648-65-1234-00000") */
  pin: string;
  /** GIS-internal PIN (typically all digits, no dashes) */
  gisPin: string;
  /** Best-known address string */
  address?: string;
  ownerName?: string;
  /** Centroid in WGS84 lon/lat */
  centroid?: { lon: number; lat: number };
  /** Polygon geometry from the parcel layer (raw, county-specific SRS) */
  geometry?: unknown;
  /** Recorded deed reference */
  deed?: { book: string; page: string };
  /** Recorded plat reference */
  plat?: { book: string; page: string };
  /** Confidence of the resolution: 1.0 exact, lower = fuzzier match */
  confidence: number;
  /** How we got here, useful for debugging */
  source: 'pin-direct' | 'address-exact' | 'address-fuzzy';
}

export interface FetcherContext {
  property: CanonicalProperty;
  /**
   * Legacy scratch directory for fetchers that haven't migrated to
   * ArtifactStore yet. Every produced file MUST still be registered as an
   * Artifact via `ctx.run.recorder.putArtifact(...)` — outDir alone is not
   * the source of truth anymore.
   */
  outDir: string;
  /** Optional progress callback for streaming updates */
  onProgress?: (event: ProgressEvent) => void;
  /** Abort signal so individual fetches can be cancelled */
  signal?: AbortSignal;
  /**
   * Run-scoped provenance handles. Present in every real run; fetchers
   * pass `run.recorder` to httpFetch so every external call is logged,
   * and call `run.recorder.putArtifact(...)` for every produced file.
   */
  run: RunContext;
}

/**
 * Run-scoped context threaded through the orchestrator into every fetcher.
 * Correlates HTTP hits and artifacts back to the originating run + call.
 */
export interface RunContext {
  runId: string;
  fetcherCallId: string;
  /** See src/provenance/recorder.ts. Typed as `unknown` here to avoid a
   *  circular import from types.ts → provenance/recorder.ts → types.ts. */
  recorder: import('./provenance/recorder.js').ProvenanceRecorder;
}

export interface ProgressEvent {
  fetcher: string;
  status: 'started' | 'progress' | 'completed' | 'failed' | 'skipped';
  message?: string;
  /** Path to a produced file, if any */
  file?: string;
  error?: string;
}

export interface FetcherResult {
  fetcher: string;
  status: 'completed' | 'failed' | 'skipped';
  /** Files this fetcher produced (PDFs, JSON, screenshots, etc.) */
  files: ProducedFile[];
  /** Free-form structured data (e.g. tax balance, owner, flood zone) */
  data?: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

export interface ProducedFile {
  /** Absolute path on disk */
  path: string;
  /** Display label for the user */
  label: string;
  /** MIME type */
  contentType: string;
}

export interface Fetcher {
  /** Stable identifier — used in progress events and disable-list */
  id: string;
  /** Human-readable name shown in the UI */
  name: string;
  /** Which counties this fetcher supports */
  counties: CountyId[];
  /** Estimated time for this fetcher; used for ETA display */
  estimatedMs?: number;
  /** Whether this fetcher needs a real browser (Playwright) vs pure HTTP */
  needsBrowser: boolean;
  /** Run the fetcher */
  run(ctx: FetcherContext): Promise<FetcherResult>;
}
