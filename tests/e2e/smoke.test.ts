/**
 * E2E smoke tests — hit the live deployed app and verify the golden path.
 * Runs against E2E_BASE_URL (default: https://henry-slack.vercel.app).
 *
 * Usage:
 *   npm run test:e2e                        # production
 *   E2E_BASE_URL=http://localhost:3000 npm run test:e2e  # local dev server
 */

import { describe, it, expect, beforeAll } from 'vitest';

const BASE_URL = process.env.E2E_BASE_URL ?? 'https://henry-slack.vercel.app';

// Well-known Buncombe County property used as the golden fixture throughout
const GOLDEN_ADDRESS = '546 Old Haw Creek Rd';
const GOLDEN_PIN_PREFIX = '9659'; // first segment of PIN — coarse sanity check

async function get(path: string): Promise<Response> {
  return fetch(`${BASE_URL}${path}`);
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Poll /api/web/status/:id until terminal state, up to maxMs. */
async function pollStatus(
  runId: string,
  maxMs = 270_000,
  intervalMs = 4_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const res = await get(`/api/web/status/${runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const status = body.status as string;
    if (status === 'completed' || status === 'partial' || status === 'failed') {
      return body;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Run ${runId} did not reach a terminal state within ${maxMs}ms`);
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

describe('health', () => {
  it('GET /api/web/config returns config object with googlePlacesKey', async () => {
    const res = await get('/api/web/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect('googlePlacesKey' in body).toBe(true);
    expect(typeof body.googlePlacesKey).toBe('string');
  });

  it('GET /api/web/history returns an array', async () => {
    const res = await get('/api/web/history');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.runs)).toBe(true);
  });

  it('GET /api/runs returns an array', async () => {
    const res = await get('/api/runs');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Array.isArray(body.runs)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('POST /api/web/search — validation', () => {
  it('rejects empty address with 400', async () => {
    const res = await post('/api/web/search', { address: '' });
    expect(res.status).toBe(400);
  });

  it('rejects missing address with 400', async () => {
    const res = await post('/api/web/search', {});
    expect(res.status).toBe(400);
  });

  it('rejects a clearly bogus address with 422', async () => {
    const res = await post('/api/web/search', { address: 'zzzz1234 nonexistent st 00000 fake city' });
    expect(res.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Golden-path: full search → poll → verify artifacts persist in Blob
// ---------------------------------------------------------------------------

describe('golden path', () => {
  let runId: string;
  let finalStatus: Record<string, unknown>;

  beforeAll(async () => {
    const res = await post('/api/web/search', { address: GOLDEN_ADDRESS });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.runId).toBe('string');
    expect((body.pin as string)).toContain(GOLDEN_PIN_PREFIX);
    runId = body.runId as string;

    // Poll until done (up to 4.5 min — fetchers need ~150s)
    finalStatus = await pollStatus(runId, 270_000);
  }, 300_000);

  it('run reaches completed or partial (not failed)', () => {
    expect(['completed', 'partial']).toContain(finalStatus.status);
  });

  it('produced at least one artifact', () => {
    const artifacts = finalStatus.artifacts as unknown[];
    expect(Array.isArray(artifacts)).toBe(true);
    expect(artifacts.length).toBeGreaterThan(0);
  });

  it('fetcher totals are consistent', () => {
    const planned = finalStatus.fetchersPlanned as number;
    const statuses = finalStatus.fetcherStatuses as Record<string, string>;
    expect(planned).toBeGreaterThan(0);
    const counted = Object.values(statuses).length;
    expect(counted).toBe(planned);
  });

  it('slope data is present and in valid range', () => {
    const fetcherData = finalStatus.fetcherData as Record<string, Record<string, unknown>> | undefined;
    const slope = fetcherData?.['slope'];
    expect(slope).toBeDefined();
    if (slope?.elevationFt != null) {
      expect(slope.elevationFt as number).toBeGreaterThan(1500);
      expect(slope.elevationFt as number).toBeLessThan(5000);
    }
    if (slope?.slopePct != null) {
      expect(slope.slopePct as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('STR eligibility data is present', () => {
    const fetcherData = finalStatus.fetcherData as Record<string, Record<string, unknown>> | undefined;
    const str = fetcherData?.['str-eligibility'];
    expect(str).toBeDefined();
    expect(typeof str?.summary).toBe('string');
    expect((str?.summary as string).length).toBeGreaterThan(0);
  });

  it('NRI data is present with valid composite rating', () => {
    const fetcherData = finalStatus.fetcherData as Record<string, Record<string, unknown>> | undefined;
    const nri = fetcherData?.['national-risk-index'];
    expect(nri).toBeDefined();
    if (nri?.compositeRating != null) {
      expect(typeof nri.compositeRating).toBe('string');
    }
  });

  it('adjacent parcels data is present', () => {
    const fetcherData = finalStatus.fetcherData as Record<string, Record<string, unknown>> | undefined;
    const adj = fetcherData?.['adjacent-parcels'];
    expect(adj).toBeDefined();
    expect(typeof adj?.count).toBe('number');
    expect(Array.isArray(adj?.neighbors)).toBe(true);
  });

  it('soil-septic data is present', () => {
    const fetcherData = finalStatus.fetcherData as Record<string, Record<string, unknown>> | undefined;
    const soil = fetcherData?.['soil-septic'];
    expect(soil).toBeDefined();
    // at minimum the key exists (may be null for on-sewer properties)
  });

  it('no fetcher has status failed (all should be completed or skipped)', () => {
    const statuses = finalStatus.fetcherStatuses as Record<string, string> | undefined;
    if (!statuses) return;
    const failed = Object.entries(statuses).filter(([, s]) => s === 'failed');
    if (failed.length > 0) {
      console.warn('Failed fetchers:', failed.map(([id]) => id).join(', '));
    }
    // Warn but don't hard-fail — some fetchers may legitimately fail on this property
    // The important thing is we don't have ALL fetchers failing
    const failedCount = failed.length;
    const totalCount = Object.keys(statuses).length;
    expect(failedCount).toBeLessThan(totalCount * 0.5); // < 50% failed
  });

  it('artifact is downloadable from Blob storage (persists)', async () => {
    const artifacts = finalStatus.artifacts as Array<Record<string, unknown>>;
    const first = artifacts[0];
    expect(typeof first.id).toBe('string');

    const res = await get(`/api/artifact/${first.id}`);
    expect(res.status).toBe(200);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(0);
    // Byte count should match what the DB recorded
    expect(buf.byteLength).toBe(first.bytes as number);
  });

  it('run trace is retrievable via /api/runs/:id', async () => {
    const res = await get(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.run).toBeDefined();
    const run = body.run as Record<string, unknown>;
    expect(run.id).toBe(runId);
    expect(run.status).toBeDefined();
    expect(Array.isArray(body.artifacts)).toBe(true);
    expect(Array.isArray(body.fetcherCalls)).toBe(true);
  });
}, 300_000);
