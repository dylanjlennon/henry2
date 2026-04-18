#!/usr/bin/env tsx
/**
 * Health check script — runs all REST fetchers against the golden property
 * and prints a status table.
 *
 * Usage:
 *   npx tsx scripts/healthCheck.ts              # golden property only
 *   npx tsx scripts/healthCheck.ts --asheville  # also test Asheville-specific fetchers
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { CanonicalProperty, FetcherContext, FetcherResult } from '../src/types.js';
import { MemoryProvenanceStore, FilesystemArtifactStore } from '../src/provenance/memoryStore.js';
import { ProvenanceRecorder } from '../src/provenance/recorder.js';
import { canonicalToSnapshot } from '../src/provenance/snapshot.js';

// Fetchers
import { parcelJsonFetcher } from '../src/fetchers/parcelJson.js';
import { femaFloodFetcher } from '../src/fetchers/femaFlood.js';
import { septicFetcher } from '../src/fetchers/septic.js';
import { slopeFetcher } from '../src/fetchers/slope.js';
import { soilSepticFetcher } from '../src/fetchers/soilSeptic.js';
import { strEligibilityFetcher } from '../src/fetchers/strEligibility.js';
import { adjacentParcelsFetcher } from '../src/fetchers/adjacentParcels.js';
import { nationalRiskIndexFetcher } from '../src/fetchers/nationalRiskIndex.js';

// ---------------------------------------------------------------------------
// Golden properties
// ---------------------------------------------------------------------------

const GOLDEN_PROPERTY: CanonicalProperty = {
  county: 'buncombe',
  pin: '9659-86-6054-00000',
  gisPin: '965986605400000',
  address: '546 OLD HAW CREEK RD',
  centroid: { lon: -82.50424695420467, lat: 35.61199078989121 },
  confidence: 1,
  source: 'pin-direct',
};

const ASHEVILLE_PROPERTY: CanonicalProperty = {
  county: 'buncombe',
  pin: '9648954289',
  gisPin: '9648954289',
  address: '14 MARNE RD',
  centroid: { lon: -82.5537, lat: 35.6123 },
  confidence: 1,
  source: 'pin-direct',
};

// ---------------------------------------------------------------------------
// Context factory
// ---------------------------------------------------------------------------

async function makeCtx(
  property: CanonicalProperty,
  dir: string,
): Promise<{ ctx: FetcherContext; recorder: ProvenanceRecorder }> {
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
  const call = await recorder.startFetcherCall('health-check', '0.1.0');
  const ctx: FetcherContext = {
    property,
    outDir: dir,
    run: { runId: recorder.runId, fetcherCallId: call.id, recorder },
  };
  return { ctx, recorder };
}

// ---------------------------------------------------------------------------
// Table output
// ---------------------------------------------------------------------------

interface Row {
  name: string;
  property: string;
  status: string;
  durationMs: number;
  keyData: string;
  error?: string;
}

function extractKeyData(fetcherId: string, result: FetcherResult): string {
  const d = result.data as Record<string, unknown> | undefined;
  if (!d) return '—';

  switch (fetcherId) {
    case 'parcel-json':
      return result.files.length > 0 ? `${result.files.length} file(s)` : '—';
    case 'fema-flood':
      return d.floodZone != null ? `zone=${d.floodZone}` : '—';
    case 'septic':
      return d.onSeptic != null ? `onSeptic=${d.onSeptic}` : '—';
    case 'slope': {
      const elev = d.elevationFt != null ? `elev=${d.elevationFt}ft` : 'elev=null';
      const slope = d.slopePct != null ? ` slope=${d.slopePct}%` : '';
      return `${elev}${slope}`;
    }
    case 'soil-septic':
      return d.mukey != null ? `mukey=${d.mukey} rating=${d.septicRating ?? 'null'}` : '—';
    case 'str-eligibility':
      return `eligible=${d.eligible} jx=${d.rulesJurisdiction}`;
    case 'adjacent-parcels':
      return `count=${d.count ?? 0}`;
    case 'national-risk-index':
      return d.compositeRating != null ? `rating=${d.compositeRating} score=${d.compositeScore}` : '—';
    default:
      return '—';
  }
}

function printTable(rows: Row[]): void {
  const COL_NAME = 32;
  const COL_PROP = 12;
  const COL_STATUS = 10;
  const COL_MS = 8;
  const COL_DATA = 50;

  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);
  const header = [
    pad('Fetcher', COL_NAME),
    pad('Property', COL_PROP),
    pad('Status', COL_STATUS),
    pad('ms', COL_MS),
    pad('Key data', COL_DATA),
  ].join(' | ');
  const sep = '-'.repeat(header.length);

  console.log('\n' + sep);
  console.log(header);
  console.log(sep);

  for (const r of rows) {
    const statusLabel = r.status === 'completed' ? '✓ ok' : r.status === 'failed' ? '✗ fail' : r.status;
    const dataOrError = r.status === 'failed' && r.error ? `ERROR: ${r.error}` : r.keyData;
    console.log([
      pad(r.name, COL_NAME),
      pad(r.property, COL_PROP),
      pad(statusLabel, COL_STATUS),
      pad(String(r.durationMs), COL_MS),
      pad(dataOrError, COL_DATA),
    ].join(' | '));
  }
  console.log(sep + '\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const withAsheville = args.includes('--asheville');

let anyFailed = false;
const rows: Row[] = [];
let dir: string | null = null;

try {
  dir = await mkdtemp(join(tmpdir(), 'henry-health-'));

  // Core fetchers run against the golden property
  const coreFetchers = [
    parcelJsonFetcher,
    femaFloodFetcher,
    septicFetcher,
    slopeFetcher,
    soilSepticFetcher,
    strEligibilityFetcher,
    adjacentParcelsFetcher,
    nationalRiskIndexFetcher,
  ];

  console.log(`[henry health-check] Running ${coreFetchers.length} fetchers against golden property...`);

  for (const fetcher of coreFetchers) {
    process.stdout.write(`  ${fetcher.name}... `);
    const { ctx } = await makeCtx(GOLDEN_PROPERTY, dir);
    const t0 = Date.now();
    let result: FetcherResult;
    try {
      result = await fetcher.run(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { fetcher: fetcher.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    }
    const ms = Date.now() - t0;
    process.stdout.write(`${result.status} (${ms}ms)\n`);
    if (result.status === 'failed') anyFailed = true;
    rows.push({
      name: fetcher.name,
      property: 'Golden',
      status: result.status,
      durationMs: ms,
      keyData: extractKeyData(fetcher.id, result),
      error: result.error,
    });
  }

  // Asheville-specific fetchers (if requested)
  if (withAsheville) {
    const ashevilleFetchers = [
      strEligibilityFetcher,
      adjacentParcelsFetcher,
    ];

    console.log(`\n[henry health-check] Running ${ashevilleFetchers.length} Asheville-specific fetchers...`);

    for (const fetcher of ashevilleFetchers) {
      process.stdout.write(`  ${fetcher.name} (Asheville)... `);
      const { ctx } = await makeCtx(ASHEVILLE_PROPERTY, dir);
      const t0 = Date.now();
      let result: FetcherResult;
      try {
        result = await fetcher.run(ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result = { fetcher: fetcher.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
      }
      const ms = Date.now() - t0;
      process.stdout.write(`${result.status} (${ms}ms)\n`);
      if (result.status === 'failed') anyFailed = true;
      rows.push({
        name: fetcher.name,
        property: 'Asheville',
        status: result.status,
        durationMs: ms,
        keyData: extractKeyData(fetcher.id, result),
        error: result.error,
      });
    }
  }

  printTable(rows);

  const failed = rows.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    console.error(`[henry health-check] FAILED: ${failed.length} fetcher(s) failed: ${failed.map((r) => r.name).join(', ')}`);
    process.exit(1);
  } else {
    console.log(`[henry health-check] All ${rows.length} fetchers OK`);
  }
} finally {
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
