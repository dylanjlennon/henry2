/**
 * Live fetcher tests — run each REST fetcher against the real Buncombe API
 * for the golden property and verify it produces a valid output file and
 * correctly records provenance.
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProperty } from '../../src/resolver/index.ts';
import { parcelJsonFetcher } from '../../src/fetchers/parcelJson.ts';
import { femaFloodFetcher } from '../../src/fetchers/femaFlood.ts';
import { septicFetcher } from '../../src/fetchers/septic.ts';
import type { CanonicalProperty, FetcherContext } from '../../src/types.ts';
import { MemoryProvenanceStore, FilesystemArtifactStore } from '../../src/provenance/memoryStore.ts';
import { ProvenanceRecorder } from '../../src/provenance/recorder.ts';
import { canonicalToSnapshot } from '../../src/provenance/snapshot.ts';

let tmp: string;
let property: CanonicalProperty;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'henry-test-'));
  property = await resolveProperty({ raw: '546 Old Haw Creek Rd', county: 'buncombe' });
}, 30_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

/** Build an isolated FetcherContext with a fresh in-memory recorder + call. */
async function makeCtx(): Promise<{ ctx: FetcherContext; store: MemoryProvenanceStore; recorder: ProvenanceRecorder }> {
  const store = new MemoryProvenanceStore();
  const artifactStore = new FilesystemArtifactStore(tmp);
  const recorder = new ProvenanceRecorder({
    store,
    artifactStore,
    invocation: {
      id: randomUUID(),
      trigger: 'cli',
      slackTeamId: null, slackUserId: null, slackChannelId: null,
      slackChannelName: null, slackThreadTs: null,
      rawInput: '546 Old Haw Creek Rd',
      createdAt: new Date().toISOString(),
    },
  });
  await recorder.saveInvocation();
  await recorder.startRun(canonicalToSnapshot(property));
  const call = await recorder.startFetcherCall('test', '0.1.0');
  const ctx: FetcherContext = {
    property,
    outDir: tmp,
    run: { runId: recorder.runId, fetcherCallId: call.id, recorder },
  };
  return { ctx, store, recorder };
}

describe('parcelJsonFetcher', () => {
  it('writes a valid parcel JSON and records provenance', async () => {
    const { ctx, recorder } = await makeCtx();
    const result = await parcelJsonFetcher.run(ctx);
    expect(result.status).toBe('completed');
    expect(result.files.length).toBe(1);
    const f = result.files[0];
    expect((await stat(f.path)).size).toBeGreaterThan(100);
    const json = JSON.parse(await readFile(f.path, 'utf8'));
    expect(json.attributes).toBeDefined();
    const trace = await recorder['store'].getRunTrace(recorder.runId);
    expect(trace?.httpHits.length).toBeGreaterThanOrEqual(1);
    expect(trace?.artifacts.length).toBe(1);
    expect(trace?.artifacts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 30_000);
});

describe('femaFloodFetcher', () => {
  it('queries flood + FIRM panel data for the golden property', async () => {
    const { ctx } = await makeCtx();
    const result = await femaFloodFetcher.run(ctx);
    expect(result.status).toBe('completed');
    expect(result.files.length).toBe(1);
    expect(result.data).toBeDefined();
    expect(result.data!.floodZone).toBeTypeOf('string');
    expect(result.data!.firmPanel).toBeTruthy();
  }, 30_000);
});

describe('septicFetcher', () => {
  it('returns septic status for the golden property', async () => {
    const { ctx } = await makeCtx();
    const result = await septicFetcher.run(ctx);
    expect(result.status).toBe('completed');
    expect(typeof result.data!.onSeptic).toBe('boolean');
  }, 30_000);
});
