/**
 * Provenance schema.
 *
 * Every externally-sourced fact in Henry is traceable back through a chain:
 *
 *     Invocation  (someone asked Henry for a property)
 *        ↓
 *     Run         (one execution of the orchestrator)
 *        ↓
 *     FetcherCall (one fetcher module's work within a run)
 *        ↓
 *     HttpHit     (a single HTTP request to an external source)
 *        ↓
 *     Artifact    (a file / JSON blob produced, with its SHA-256 digest)
 *
 * We record every link in that chain with zod-validated shapes. This makes
 * the audit trail queryable: given any artifact, you can answer "what URL
 * did this come from? when? what was the response code? what version of
 * the fetcher ran? who initiated the run?"
 *
 * Everything here is transport-agnostic — the same shapes are stored in
 * Postgres in production and in an in-memory map in tests.
 */

import { z } from 'zod';

/** Fixed version tag baked into every run; bumped when behavior changes. */
export const HENRY_VERSION = '0.1.0';

/** Identifier for a deterministic, deduplicable HTTP request. */
export const HttpRequestRef = z.object({
  method: z.string(),
  url: z.string().url(),
  /** SHA-256 of `${method} ${url}\n${sorted headers}\n${body}` — dedupe key. */
  requestHash: z.string().length(64),
});
export type HttpRequestRef = z.infer<typeof HttpRequestRef>;

/** Recorded result of an HTTP call to an external source. */
export const HttpHit = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  fetcherCallId: z.string().uuid().nullable(),
  method: z.string(),
  url: z.string().url(),
  /** Request hash for dedupe */
  requestHash: z.string().length(64),
  /** Optional per-host classification, e.g. "buncombe.gis", "fema.nfhl" */
  sourceLabel: z.string(),
  status: z.number().int().nullable(),
  responseBytes: z.number().int().nonnegative().nullable(),
  responseSha256: z.string().length(64).nullable(),
  responseContentType: z.string().nullable(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  error: z.string().nullable(),
  /** Attempt number (0 = first try, incremented on retry). */
  attempt: z.number().int().nonnegative(),
});
export type HttpHit = z.infer<typeof HttpHit>;

/** One fetcher's execution within a run. */
export const FetcherCall = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  fetcherId: z.string(),
  fetcherVersion: z.string(),
  status: z.enum(['pending', 'completed', 'failed', 'skipped', 'timeout']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
  /** Summary data the fetcher produced (e.g. flood zone code, septic flag). */
  data: z.record(z.unknown()).nullable(),
});
export type FetcherCall = z.infer<typeof FetcherCall>;

/** A file produced by a fetcher, with its provenance. */
export const Artifact = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  fetcherCallId: z.string().uuid(),
  /** Stable label shown to users, e.g. "Deed (Book 6541 Page 0364)" */
  label: z.string(),
  contentType: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  /** Canonical source URL this artifact represents (even if not directly downloaded) */
  sourceUrl: z.string().url().nullable(),
  /** Storage key/URL where the artifact lives (blob store or local path) */
  storageUri: z.string(),
  createdAt: z.string().datetime(),
});
export type Artifact = z.infer<typeof Artifact>;

/** Canonical property snapshot at the moment the run was started. */
export const PropertySnapshot = z.object({
  county: z.string(),
  pin: z.string(),
  gisPin: z.string(),
  address: z.string().nullable(),
  ownerName: z.string().nullable(),
  centroidLon: z.number().nullable(),
  centroidLat: z.number().nullable(),
  deedBook: z.string().nullable(),
  deedPage: z.string().nullable(),
  platBook: z.string().nullable(),
  platPage: z.string().nullable(),
  resolutionSource: z.string(),
  resolutionConfidence: z.number().min(0).max(1),
});
export type PropertySnapshot = z.infer<typeof PropertySnapshot>;

/** What triggered a run: who, where, how. */
export const Invocation = z.object({
  id: z.string().uuid(),
  trigger: z.enum(['slack-slash', 'slack-mention', 'api', 'cli', 'scheduled', 'web']),
  slackTeamId: z.string().nullable(),
  slackUserId: z.string().nullable(),
  slackChannelId: z.string().nullable(),
  slackChannelName: z.string().nullable(),
  slackThreadTs: z.string().nullable(),
  /** Exactly what the user typed (before normalization) */
  rawInput: z.string(),
  createdAt: z.string().datetime(),
  /** SHA-256 of client IP — web-only, null for Slack/CLI invocations. */
  ipHash: z.string().nullable().optional(),
});
export type Invocation = z.infer<typeof Invocation>;

/** One execution of the orchestrator — links invocation → property → artifacts. */
export const Run = z.object({
  id: z.string().uuid(),
  invocationId: z.string().uuid(),
  henryVersion: z.string(),
  property: PropertySnapshot,
  status: z.enum(['running', 'completed', 'partial', 'failed']),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  totals: z.object({
    fetchersTotal: z.number().int().nonnegative(),
    fetchersCompleted: z.number().int().nonnegative(),
    fetchersFailed: z.number().int().nonnegative(),
    fetchersSkipped: z.number().int().nonnegative(),
    artifactsProduced: z.number().int().nonnegative(),
    httpHits: z.number().int().nonnegative(),
  }),
});
export type Run = z.infer<typeof Run>;

/** Full, assembled trace for a single run. Used by /api/runs/:id. */
export const RunTrace = z.object({
  invocation: Invocation,
  run: Run,
  fetcherCalls: z.array(FetcherCall),
  httpHits: z.array(HttpHit),
  artifacts: z.array(Artifact),
});
export type RunTrace = z.infer<typeof RunTrace>;
