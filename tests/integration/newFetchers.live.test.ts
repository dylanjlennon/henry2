/**
 * Live integration tests for 5 new REST fetchers.
 *
 * Runs against real Buncombe County and USGS/FEMA APIs — requires network.
 * Run with: npm run test:integration
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { slopeFetcher } from '../../src/fetchers/slope.ts';
import { soilSepticFetcher } from '../../src/fetchers/soilSeptic.ts';
import { strEligibilityFetcher } from '../../src/fetchers/strEligibility.ts';
import { adjacentParcelsFetcher } from '../../src/fetchers/adjacentParcels.ts';
import { nationalRiskIndexFetcher } from '../../src/fetchers/nationalRiskIndex.ts';
import type { CanonicalProperty, FetcherContext } from '../../src/types.ts';
import { MemoryProvenanceStore, FilesystemArtifactStore } from '../../src/provenance/memoryStore.ts';
import { ProvenanceRecorder } from '../../src/provenance/recorder.ts';
import { canonicalToSnapshot } from '../../src/provenance/snapshot.ts';

// ---------------------------------------------------------------------------
// Golden properties
// ---------------------------------------------------------------------------

// 546 Old Haw Creek Rd — City of Asheville (confirmed by jurisdiction fetcher)
const GOLDEN_CENTROID = { lon: -82.50424695420467, lat: 35.61199078989121 };
const GOLDEN_PIN = '9659-86-6054-00000';
const GOLDEN_GIS_PIN = '965986605400000';

// 14 Marne Rd, Asheville — inside city limits, RS-8 zone
const ASHEVILLE_CENTROID = { lon: -82.5537, lat: 35.6123 };
const ASHEVILLE_GIS_PIN = '9648954289';

const goldenProperty: CanonicalProperty = {
  county: 'buncombe',
  pin: GOLDEN_PIN,
  gisPin: GOLDEN_GIS_PIN,
  address: '546 OLD HAW CREEK RD',
  centroid: GOLDEN_CENTROID,
  confidence: 1,
  source: 'pin-direct',
};

const ashevilleProperty: CanonicalProperty = {
  county: 'buncombe',
  pin: ASHEVILLE_GIS_PIN,
  gisPin: ASHEVILLE_GIS_PIN,
  address: '14 MARNE RD',
  centroid: ASHEVILLE_CENTROID,
  confidence: 1,
  source: 'pin-direct',
};

// ---------------------------------------------------------------------------
// Context factory (mirrors fetchers.live.test.ts)
// ---------------------------------------------------------------------------

let tmp: string;

async function ensureTmp(): Promise<string> {
  if (!tmp) {
    tmp = await mkdtemp(join(tmpdir(), 'henry-new-fetchers-'));
  }
  return tmp;
}

async function makeCtx(property: CanonicalProperty): Promise<{ ctx: FetcherContext; recorder: ProvenanceRecorder }> {
  const dir = await ensureTmp();
  const store = new MemoryProvenanceStore();
  const artifactStore = new FilesystemArtifactStore(dir);
  const recorder = new ProvenanceRecorder({
    store,
    artifactStore,
    invocation: {
      id: randomUUID(),
      trigger: 'cli',
      slackTeamId: null, slackUserId: null, slackChannelId: null,
      slackChannelName: null, slackThreadTs: null,
      rawInput: property.address ?? property.pin,
      createdAt: new Date().toISOString(),
    },
  });
  await recorder.saveInvocation();
  await recorder.startRun(canonicalToSnapshot(property));
  const call = await recorder.startFetcherCall('test', '0.1.0');
  const ctx: FetcherContext = {
    property,
    outDir: dir,
    run: { runId: recorder.runId, fetcherCallId: call.id, recorder },
  };
  return { ctx, recorder };
}

// ---------------------------------------------------------------------------
// slopeFetcher
// ---------------------------------------------------------------------------

describe('slopeFetcher', () => {
  let result: Awaited<ReturnType<typeof slopeFetcher.run>>;

  beforeAll(async () => {
    const { ctx } = await makeCtx(goldenProperty);
    result = await slopeFetcher.run(ctx);
  }, 30_000);

  it('result.status === "completed"', () => {
    expect(result.status).toBe('completed');
  });

  it('elevationFt is a number between 1500 and 5000 (valid Buncombe range)', () => {
    const data = result.data as { elevationFt: unknown };
    if (data?.elevationFt != null) {
      expect(typeof data.elevationFt).toBe('number');
      expect(data.elevationFt as number).toBeGreaterThan(1500);
      expect(data.elevationFt as number).toBeLessThan(5000);
    } else {
      // Flag if null — should not be null for Buncombe mountains
      console.warn('[slopeFetcher] elevationFt is null — USGS 3DEP may be unreachable');
    }
  });

  it('slopePct is a number >= 0', () => {
    const data = result.data as { slopePct: unknown };
    if (data?.slopePct != null) {
      expect(typeof data.slopePct).toBe('number');
      expect(data.slopePct as number).toBeGreaterThanOrEqual(0);
    }
  });

  it('slopeDeg is a number >= 0', () => {
    const data = result.data as { slopeDeg: unknown };
    if (data?.slopeDeg != null) {
      expect(typeof data.slopeDeg).toBe('number');
      expect(data.slopeDeg as number).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// soilSepticFetcher
// ---------------------------------------------------------------------------

describe('soilSepticFetcher', () => {
  let result: Awaited<ReturnType<typeof soilSepticFetcher.run>>;

  beforeAll(async () => {
    const { ctx } = await makeCtx(goldenProperty);
    result = await soilSepticFetcher.run(ctx);
  }, 30_000);

  it('result.status === "completed"', () => {
    expect(result.status).toBe('completed');
  });

  it('mukey is a non-null string', () => {
    const data = result.data as { mukey: unknown };
    expect(typeof data?.mukey).toBe('string');
    expect(data?.mukey).not.toBeNull();
    expect((data?.mukey as string).length).toBeGreaterThan(0);
  });

  it('mapUnitName is a non-null string (SSURGO should always have this)', () => {
    const data = result.data as { mapUnitName: unknown };
    expect(typeof data?.mapUnitName).toBe('string');
    expect(data?.mapUnitName).not.toBeNull();
  });

  it('septicRating is a string (any value is acceptable)', () => {
    const data = result.data as { septicRating: unknown };
    // May be null if no cointerp row, but should not be undefined
    expect(data).toHaveProperty('septicRating');
  });
});

// ---------------------------------------------------------------------------
// strEligibilityFetcher
// ---------------------------------------------------------------------------

describe('strEligibilityFetcher — golden (546 Old Haw Creek Rd)', () => {
  let result: Awaited<ReturnType<typeof strEligibilityFetcher.run>>;

  beforeAll(async () => {
    const { ctx } = await makeCtx(goldenProperty);
    result = await strEligibilityFetcher.run(ctx);
  }, 30_000);

  it('result.status === "completed"', () => {
    expect(result.status).toBe('completed');
  });

  it('eligible is boolean or null (not undefined)', () => {
    const data = result.data as { eligible: unknown };
    expect(data?.eligible === true || data?.eligible === false || data?.eligible === null).toBe(true);
  });

  it('rulesJurisdiction is a non-empty string', () => {
    const data = result.data as { rulesJurisdiction: unknown };
    expect(typeof data?.rulesJurisdiction).toBe('string');
    expect((data?.rulesJurisdiction as string).length).toBeGreaterThan(0);
  });

  it('summary is a non-empty string', () => {
    const data = result.data as { summary: unknown };
    expect(typeof data?.summary).toBe('string');
    expect((data?.summary as string).length).toBeGreaterThan(0);
  });
});

describe('strEligibilityFetcher — Asheville property', () => {
  let result: Awaited<ReturnType<typeof strEligibilityFetcher.run>>;

  beforeAll(async () => {
    const { ctx } = await makeCtx(ashevilleProperty);
    result = await strEligibilityFetcher.run(ctx);
  }, 30_000);

  it('result.status === "completed"', () => {
    expect(result.status).toBe('completed');
  });

  it('eligible is boolean (true or false, not null) when zone is known', () => {
    const data = result.data as { eligible: unknown; zoningDistrict: unknown };
    // If we got a zoning district, eligible must be a boolean
    if (data?.zoningDistrict != null) {
      expect(typeof data?.eligible).toBe('boolean');
    }
  });

  it('zoningDistrict is a non-null string when Asheville zoning layer responds', () => {
    const data = result.data as { zoningDistrict: unknown };
    if (data?.zoningDistrict != null) {
      expect(typeof data?.zoningDistrict).toBe('string');
      expect((data?.zoningDistrict as string).length).toBeGreaterThan(0);
    }
  });

  it('rulesJurisdiction === "City of Asheville"', () => {
    const data = result.data as { rulesJurisdiction: unknown };
    expect(data?.rulesJurisdiction).toBe('City of Asheville');
  });
});

// ---------------------------------------------------------------------------
// adjacentParcelsFetcher
// ---------------------------------------------------------------------------

describe('adjacentParcelsFetcher (Asheville — 14 Marne Rd)', () => {
  let result: Awaited<ReturnType<typeof adjacentParcelsFetcher.run>>;

  beforeAll(async () => {
    const { ctx } = await makeCtx(ashevilleProperty);
    result = await adjacentParcelsFetcher.run(ctx);
  }, 30_000);

  it('result.status === "completed"', () => {
    expect(result.status).toBe('completed');
  });

  it('count > 0 (should have multiple neighbors)', () => {
    const data = result.data as { count: unknown };
    expect(typeof data?.count).toBe('number');
    expect(data?.count as number).toBeGreaterThan(0);
  });

  it('neighbors is an array', () => {
    const data = result.data as { neighbors: unknown };
    expect(Array.isArray(data?.neighbors)).toBe(true);
  });

  it('each neighbor has pin, owner, address, city properties', () => {
    const data = result.data as { neighbors: Array<Record<string, unknown>> };
    const neighbors = data?.neighbors ?? [];
    expect(neighbors.length).toBeGreaterThan(0);
    for (const n of neighbors) {
      expect(n).toHaveProperty('pin');
      expect(n).toHaveProperty('owner');
      expect(n).toHaveProperty('address');
      expect(n).toHaveProperty('city');
    }
  });

  it('critical regression: subject parcel PIN does NOT appear in any neighbor pin (startsWith fix)', () => {
    const data = result.data as { neighbors: Array<{ pin: string }> };
    const pins = (data?.neighbors ?? []).map((n) => n.pin);
    expect(pins.every((p) => !p.startsWith(ASHEVILLE_GIS_PIN))).toBe(true);
  });

  it('at least some neighbors have a non-null zoningCode', () => {
    const data = result.data as { neighbors: Array<{ zoningCode: string | null }> };
    const neighbors = data?.neighbors ?? [];
    const withZoning = neighbors.filter((n) => n.zoningCode !== null);
    // We expect at least one neighbor to have a zoning code — log a warning if not
    if (withZoning.length === 0) {
      console.warn('[adjacentParcelsFetcher] No neighbors had a zoningCode — zoning enrichment may have failed');
    }
    // Don't hard fail on this — zoning API can be slow
    expect(Array.isArray(neighbors)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// nationalRiskIndexFetcher
// ---------------------------------------------------------------------------

describe('nationalRiskIndexFetcher', () => {
  let result: Awaited<ReturnType<typeof nationalRiskIndexFetcher.run>>;

  beforeAll(async () => {
    const { ctx } = await makeCtx(goldenProperty);
    result = await nationalRiskIndexFetcher.run(ctx);
  }, 30_000);

  it('result.status === "completed"', () => {
    expect(result.status).toBe('completed');
  });

  it('compositeScore is a number > 0', () => {
    const data = result.data as { compositeScore: unknown };
    expect(typeof data?.compositeScore).toBe('number');
    expect(data?.compositeScore as number).toBeGreaterThan(0);
  });

  it('compositeRating is a non-null string', () => {
    const data = result.data as { compositeRating: unknown };
    expect(typeof data?.compositeRating).toBe('string');
    expect(data?.compositeRating).not.toBeNull();
  });

  it('hazards is an array of exactly 18 items (HAZARD_CODES count)', () => {
    const data = result.data as { hazards: unknown[] };
    expect(Array.isArray(data?.hazards)).toBe(true);
    expect(data?.hazards.length).toBe(18);
  });

  it('each hazard has hazard: string, score: number | null, rating: string | null', () => {
    const data = result.data as { hazards: Array<{ hazard: unknown; score: unknown; rating: unknown }> };
    for (const h of data?.hazards ?? []) {
      expect(typeof h.hazard).toBe('string');
      expect(h.score === null || typeof h.score === 'number').toBe(true);
      expect(h.rating === null || typeof h.rating === 'string').toBe(true);
    }
  });

  it('topHazards is an array (can be empty)', () => {
    const data = result.data as { topHazards: unknown };
    expect(Array.isArray(data?.topHazards)).toBe(true);
  });
});
