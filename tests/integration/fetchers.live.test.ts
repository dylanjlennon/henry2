/**
 * Live fetcher tests — run each REST fetcher against the real Buncombe API
 * for the golden property and verify it produces a valid output file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveProperty } from '../../src/resolver/index.ts';
import { parcelJsonFetcher } from '../../src/fetchers/parcelJson.ts';
import { femaFloodFetcher } from '../../src/fetchers/femaFlood.ts';
import { septicFetcher } from '../../src/fetchers/septic.ts';
import type { CanonicalProperty } from '../../src/types.ts';

let tmp: string;
let property: CanonicalProperty;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'henry-test-'));
  property = await resolveProperty({ raw: '546 Old Haw Creek Rd', county: 'buncombe' });
}, 30_000);

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe('parcelJsonFetcher', () => {
  it('writes a valid parcel JSON for the golden property', async () => {
    const result = await parcelJsonFetcher.run({ property, outDir: tmp });
    expect(result.status).toBe('completed');
    expect(result.files.length).toBe(1);
    const f = result.files[0];
    expect((await stat(f.path)).size).toBeGreaterThan(100);
    const json = JSON.parse(await readFile(f.path, 'utf8'));
    expect(json.attributes).toBeDefined();
  }, 30_000);
});

describe('femaFloodFetcher', () => {
  it('queries flood + FIRM panel data for the golden property', async () => {
    const result = await femaFloodFetcher.run({ property, outDir: tmp });
    expect(result.status).toBe('completed');
    expect(result.files.length).toBe(1);
    expect(result.data).toBeDefined();
    expect(result.data!.floodZone).toBeTypeOf('string');
    // The golden property is in Asheville — FIRM panel should exist
    expect(result.data!.firmPanel).toBeTruthy();
  }, 30_000);
});

describe('septicFetcher', () => {
  it('returns septic status for the golden property', async () => {
    const result = await septicFetcher.run({ property, outDir: tmp });
    expect(result.status).toBe('completed');
    expect(typeof result.data!.onSeptic).toBe('boolean');
  }, 30_000);
});
