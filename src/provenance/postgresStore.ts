/**
 * PostgresProvenanceStore — production-grade provenance persistence.
 *
 * Works with any standard Postgres (Vercel Postgres, Neon, Supabase, or
 * your own RDS). The schema is defined in `migrations/001_init.sql`.
 *
 * Connection handling:
 *   - Accepts an already-configured `pg.Pool` (preferred for serverless),
 *     or a `DATABASE_URL` string.
 *   - In a serverless context you should share a single module-scoped Pool
 *     across invocations. See `getSharedPool()` at the bottom of this file.
 *
 * Correctness:
 *   - All inserts use parameterized queries. No string interpolation of
 *     user data anywhere.
 *   - Updates use `ON CONFLICT (id) DO UPDATE` so saveX / updateX are
 *     idempotent — replaying a write after a transient error is safe.
 *   - Every row round-trips through the zod schemas so we catch drift
 *     between the code model and the database.
 */

import type { Pool, PoolClient } from 'pg';
import {
  Artifact,
  FetcherCall,
  HttpHit,
  Invocation,
  Run,
  RunTrace,
} from './schema.js';
import type { ProvenanceStore, WebRunStatus, WebRunRow } from './store.js';

export interface PostgresProvenanceStoreOptions {
  pool: Pool;
}

export class PostgresProvenanceStore implements ProvenanceStore {
  private readonly pool: Pool;

  constructor(opts: PostgresProvenanceStoreOptions) {
    this.pool = opts.pool;
  }

  async saveInvocation(inv: Invocation): Promise<void> {
    Invocation.parse(inv);
    await this.pool.query(
      `INSERT INTO invocations (
         id, trigger, slack_team_id, slack_user_id, slack_channel_id,
         slack_channel_name, slack_thread_ts, raw_input, created_at, ip_hash
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         trigger = EXCLUDED.trigger,
         slack_team_id = EXCLUDED.slack_team_id,
         slack_user_id = EXCLUDED.slack_user_id,
         slack_channel_id = EXCLUDED.slack_channel_id,
         slack_channel_name = EXCLUDED.slack_channel_name,
         slack_thread_ts = EXCLUDED.slack_thread_ts,
         raw_input = EXCLUDED.raw_input,
         ip_hash = EXCLUDED.ip_hash`,
      [
        inv.id, inv.trigger, inv.slackTeamId, inv.slackUserId, inv.slackChannelId,
        inv.slackChannelName, inv.slackThreadTs, inv.rawInput, inv.createdAt,
        inv.ipHash ?? null,
      ],
    );
  }

  async saveRun(run: Run): Promise<void> {
    Run.parse(run);
    await this.upsertRun(run);
  }

  async updateRun(run: Run): Promise<void> {
    Run.parse(run);
    await this.upsertRun(run);
  }

  private async upsertRun(run: Run): Promise<void> {
    const p = run.property;
    await this.pool.query(
      `INSERT INTO runs (
         id, invocation_id, henry_version, county, pin, gis_pin, address,
         owner_name, centroid_lon, centroid_lat, deed_book, deed_page,
         plat_book, plat_page, resolution_source, resolution_confidence,
         status, started_at, finished_at, duration_ms,
         fetchers_total, fetchers_completed, fetchers_failed,
         fetchers_skipped, artifacts_produced, http_hits
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
         $21,$22,$23,$24,$25,$26
       )
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms,
         fetchers_total = EXCLUDED.fetchers_total,
         fetchers_completed = EXCLUDED.fetchers_completed,
         fetchers_failed = EXCLUDED.fetchers_failed,
         fetchers_skipped = EXCLUDED.fetchers_skipped,
         artifacts_produced = EXCLUDED.artifacts_produced,
         http_hits = EXCLUDED.http_hits`,
      [
        run.id, run.invocationId, run.henryVersion,
        p.county, p.pin, p.gisPin, p.address, p.ownerName,
        p.centroidLon, p.centroidLat, p.deedBook, p.deedPage,
        p.platBook, p.platPage, p.resolutionSource, p.resolutionConfidence,
        run.status, run.startedAt, run.finishedAt, run.durationMs,
        run.totals.fetchersTotal, run.totals.fetchersCompleted,
        run.totals.fetchersFailed, run.totals.fetchersSkipped,
        run.totals.artifactsProduced, run.totals.httpHits,
      ],
    );
  }

  async saveFetcherCall(call: FetcherCall): Promise<void> {
    FetcherCall.parse(call);
    await this.upsertFetcherCall(call);
  }

  async updateFetcherCall(call: FetcherCall): Promise<void> {
    FetcherCall.parse(call);
    await this.upsertFetcherCall(call);
  }

  private async upsertFetcherCall(call: FetcherCall): Promise<void> {
    await this.pool.query(
      `INSERT INTO fetcher_calls (
         id, run_id, fetcher_id, fetcher_version, status,
         started_at, finished_at, duration_ms, error, data
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         finished_at = EXCLUDED.finished_at,
         duration_ms = EXCLUDED.duration_ms,
         error = EXCLUDED.error,
         data = EXCLUDED.data`,
      [
        call.id, call.runId, call.fetcherId, call.fetcherVersion,
        call.status, call.startedAt, call.finishedAt, call.durationMs,
        call.error, call.data ? JSON.stringify(call.data) : null,
      ],
    );
  }

  async saveHttpHit(hit: HttpHit): Promise<void> {
    HttpHit.parse(hit);
    await this.pool.query(
      `INSERT INTO http_hits (
         id, run_id, fetcher_call_id, method, url, request_hash, source_label,
         status, response_bytes, response_sha256, response_content_type,
         started_at, finished_at, duration_ms, error, attempt
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        hit.id, hit.runId, hit.fetcherCallId, hit.method, hit.url,
        hit.requestHash, hit.sourceLabel, hit.status, hit.responseBytes,
        hit.responseSha256, hit.responseContentType, hit.startedAt,
        hit.finishedAt, hit.durationMs, hit.error, hit.attempt,
      ],
    );
  }

  async saveArtifact(a: Artifact): Promise<void> {
    Artifact.parse(a);
    await this.pool.query(
      `INSERT INTO artifacts (
         id, run_id, fetcher_call_id, label, content_type, bytes,
         sha256, source_url, storage_uri, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        a.id, a.runId, a.fetcherCallId, a.label, a.contentType, a.bytes,
        a.sha256, a.sourceUrl, a.storageUri, a.createdAt,
      ],
    );
  }

  async getArtifact(id: string): Promise<Artifact | null> {
    const res = await this.pool.query(
      `SELECT * FROM artifacts WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (res.rowCount === 0) return null;
    return artifactFromRow(res.rows[0]);
  }

  async getRunTrace(runId: string): Promise<RunTrace | null> {
    const client: PoolClient = await this.pool.connect();
    try {
      const runRes = await client.query(
        `SELECT r.*, i.id AS inv_id, i.trigger, i.slack_team_id, i.slack_user_id,
                i.slack_channel_id, i.slack_channel_name, i.slack_thread_ts,
                i.raw_input, i.created_at AS inv_created_at
         FROM runs r JOIN invocations i ON r.invocation_id = i.id
         WHERE r.id = $1`,
        [runId],
      );
      if (runRes.rowCount === 0) return null;
      const row = runRes.rows[0];
      const invocation: Invocation = Invocation.parse({
        id: row.inv_id,
        trigger: row.trigger,
        slackTeamId: row.slack_team_id,
        slackUserId: row.slack_user_id,
        slackChannelId: row.slack_channel_id,
        slackChannelName: row.slack_channel_name,
        slackThreadTs: row.slack_thread_ts,
        rawInput: row.raw_input,
        createdAt: iso(row.inv_created_at),
      });
      const run = runFromRow(row);

      const [fcRes, hitRes, artRes] = await Promise.all([
        client.query(`SELECT * FROM fetcher_calls WHERE run_id = $1 ORDER BY started_at ASC`, [runId]),
        client.query(`SELECT * FROM http_hits WHERE run_id = $1 ORDER BY started_at ASC`, [runId]),
        client.query(`SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC`, [runId]),
      ]);

      return RunTrace.parse({
        invocation,
        run,
        fetcherCalls: fcRes.rows.map(fetcherCallFromRow),
        httpHits: hitRes.rows.map(httpHitFromRow),
        artifacts: artRes.rows.map(artifactFromRow),
      });
    } finally {
      client.release();
    }
  }

  async listRuns(opts: { limit?: number; offset?: number } = {}): Promise<Run[]> {
    const limit = Math.min(opts.limit ?? 50, 200);
    const offset = opts.offset ?? 0;
    const res = await this.pool.query(
      `SELECT * FROM runs ORDER BY started_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return res.rows.map(runFromRow);
  }

  async getWebRunStatus(runId: string): Promise<WebRunStatus | null> {
    const runRes = await this.pool.query(
      `SELECT r.id, r.status, r.pin, r.address, r.owner_name,
              r.fetchers_total, r.fetchers_completed, r.fetchers_failed,
              r.started_at, r.duration_ms
       FROM runs r
       JOIN invocations i ON r.invocation_id = i.id
       WHERE r.id = $1 AND i.trigger = 'web'`,
      [runId],
    );
    if (runRes.rowCount === 0) return null;
    const row = runRes.rows[0];

    const [fcRes, artRes] = await Promise.all([
      this.pool.query(
        `SELECT fetcher_id, status, data FROM fetcher_calls WHERE run_id = $1`,
        [runId],
      ),
      this.pool.query(
        `SELECT id, label, content_type, bytes FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC`,
        [runId],
      ),
    ]);

    const fetcherStatuses: Record<string, string> = {};
    const fetcherData: Record<string, Record<string, unknown>> = {};
    for (const fc of fcRes.rows) {
      fetcherStatuses[fc.fetcher_id] = fc.status;
      if (fc.data) fetcherData[fc.fetcher_id] = fc.data as Record<string, unknown>;
    }

    return {
      runId: String(row.id),
      status: row.status,
      pin: row.pin,
      address: row.address ?? null,
      ownerName: row.owner_name ?? null,
      fetchersPlanned: Number(row.fetchers_total),
      fetchersCompleted: Number(row.fetchers_completed),
      fetchersFailed: Number(row.fetchers_failed),
      startedAt: iso(row.started_at),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      artifacts: artRes.rows.map((a) => ({
        id: String(a.id),
        label: String(a.label),
        contentType: String(a.content_type),
        bytes: Number(a.bytes),
      })),
      fetcherStatuses,
      fetcherData,
    };
  }

  async listWebRuns(opts: { limit?: number; cursor?: string } = {}): Promise<WebRunRow[]> {
    const limit = Math.min(opts.limit ?? 50, 100);
    const res = await this.pool.query(
      `SELECT r.id, r.pin, r.address, r.status,
              r.fetchers_total, r.fetchers_completed,
              r.artifacts_produced, r.duration_ms, r.started_at
       FROM runs r
       JOIN invocations i ON r.invocation_id = i.id
       WHERE i.trigger = 'web'
         ${opts.cursor ? `AND r.started_at < $2` : ''}
       ORDER BY r.started_at DESC
       LIMIT $1`,
      opts.cursor ? [limit, opts.cursor] : [limit],
    );
    return res.rows.map((row) => ({
      runId: String(row.id),
      address: row.address ?? null,
      pin: String(row.pin),
      status: String(row.status),
      fetchersCompleted: Number(row.fetchers_completed),
      fetchersPlanned: Number(row.fetchers_total),
      artifactsProduced: Number(row.artifacts_produced),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      startedAt: iso(row.started_at),
    }));
  }

  async countRecentWebRunsByIp(ipHash: string, sinceMs: number): Promise<number> {
    const since = new Date(Date.now() - sinceMs).toISOString();
    const res = await this.pool.query(
      `SELECT COUNT(*) AS cnt FROM invocations
       WHERE trigger = 'web' AND ip_hash = $1 AND created_at > $2`,
      [ipHash, since],
    );
    return Number(res.rows[0]?.cnt ?? 0);
  }
}

function runFromRow(row: Record<string, unknown>): Run {
  return Run.parse({
    id: row.id,
    invocationId: row.invocation_id,
    henryVersion: row.henry_version,
    property: {
      county: row.county,
      pin: row.pin,
      gisPin: row.gis_pin,
      address: row.address,
      ownerName: row.owner_name,
      centroidLon: row.centroid_lon == null ? null : Number(row.centroid_lon),
      centroidLat: row.centroid_lat == null ? null : Number(row.centroid_lat),
      deedBook: row.deed_book,
      deedPage: row.deed_page,
      platBook: row.plat_book,
      platPage: row.plat_page,
      resolutionSource: row.resolution_source,
      resolutionConfidence: Number(row.resolution_confidence),
    },
    status: row.status,
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    totals: {
      fetchersTotal: Number(row.fetchers_total),
      fetchersCompleted: Number(row.fetchers_completed),
      fetchersFailed: Number(row.fetchers_failed),
      fetchersSkipped: Number(row.fetchers_skipped),
      artifactsProduced: Number(row.artifacts_produced),
      httpHits: Number(row.http_hits),
    },
  });
}

function fetcherCallFromRow(row: Record<string, unknown>): FetcherCall {
  return FetcherCall.parse({
    id: row.id,
    runId: row.run_id,
    fetcherId: row.fetcher_id,
    fetcherVersion: row.fetcher_version,
    status: row.status,
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at == null ? null : iso(row.finished_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    error: row.error == null ? null : String(row.error),
    data: row.data == null ? null : row.data as Record<string, unknown>,
  });
}

function httpHitFromRow(row: Record<string, unknown>): HttpHit {
  return HttpHit.parse({
    id: row.id,
    runId: row.run_id,
    fetcherCallId: row.fetcher_call_id,
    method: row.method,
    url: row.url,
    requestHash: row.request_hash,
    sourceLabel: row.source_label,
    status: row.status == null ? null : Number(row.status),
    responseBytes: row.response_bytes == null ? null : Number(row.response_bytes),
    responseSha256: row.response_sha256 == null ? null : String(row.response_sha256),
    responseContentType: row.response_content_type == null ? null : String(row.response_content_type),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    durationMs: Number(row.duration_ms),
    error: row.error == null ? null : String(row.error),
    attempt: Number(row.attempt),
  });
}

function artifactFromRow(row: Record<string, unknown>): Artifact {
  return Artifact.parse({
    id: row.id,
    runId: row.run_id,
    fetcherCallId: row.fetcher_call_id,
    label: row.label,
    contentType: row.content_type,
    bytes: Number(row.bytes),
    sha256: row.sha256,
    sourceUrl: row.source_url == null ? null : String(row.source_url),
    storageUri: row.storage_uri,
    createdAt: iso(row.created_at),
  });
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** Lazily-created, module-scoped Pool reused across serverless invocations. */
let sharedPool: Pool | null = null;
export async function getSharedPool(): Promise<Pool> {
  if (sharedPool) return sharedPool;
  const { Pool } = await import('pg');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  sharedPool = new Pool({
    connectionString: url,
    // Keep pool small — each Lambda gets a cold start on scale-out.
    max: Number(process.env.PG_POOL_MAX ?? 3),
    // In production (Neon, Vercel Postgres, Supabase) TLS is required.
    ssl: url.includes('sslmode=disable') ? false : { rejectUnauthorized: false },
    // Fail fast rather than hanging indefinitely in serverless environments.
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 20_000,
  });
  // Eagerly open one TCP connection so subsequent queries can reuse it.
  // In Vercel serverless, new outbound TCP connections are restricted after
  // res.send() completes — this must run while the request is still active.
  const client = await sharedPool.connect();
  client.release();
  return sharedPool;
}
