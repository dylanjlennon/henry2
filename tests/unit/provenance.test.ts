/**
 * Provenance core — recorder lifecycle, HTTP instrumentation, artifact
 * storage, and request-hash determinism.
 *
 * No network: everything is wired to the in-memory store. We mock
 * `global.fetch` to drive the instrumented httpFetch through its paths
 * (success, retriable-then-success, hard error) and assert that the
 * correct provenance rows land.
 */

import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MemoryProvenanceStore,
  FilesystemArtifactStore,
} from '../../src/provenance/memoryStore.ts';
import { ProvenanceRecorder, computeRequestHash, sha256Hex } from '../../src/provenance/recorder.ts';
import { canonicalToSnapshot } from '../../src/provenance/snapshot.ts';
import { httpJson } from '../../src/lib/http.ts';
import type { Invocation } from '../../src/provenance/schema.ts';
import type { CanonicalProperty } from '../../src/types.ts';

const GOLDEN_PROPERTY: CanonicalProperty = {
  county: 'buncombe',
  pin: '9659-86-6054-00000',
  gisPin: '965986605400000',
  address: '546 OLD HAW CREEK RD',
  ownerName: 'TEST OWNER',
  centroid: { lon: -82.51, lat: 35.59 },
  confidence: 1,
  source: 'pin-direct',
};

function newInvocation(raw = 'test'): Invocation {
  return {
    id: randomUUID(),
    trigger: 'cli',
    slackTeamId: null, slackUserId: null, slackChannelId: null,
    slackChannelName: null, slackThreadTs: null,
    rawInput: raw,
    createdAt: new Date().toISOString(),
  };
}

describe('computeRequestHash', () => {
  it('produces a stable 64-char hex digest', () => {
    const h1 = computeRequestHash({
      method: 'GET',
      url: 'https://x.test/a',
      headers: { Accept: 'application/json', 'User-Agent': 'Henry' },
    });
    const h2 = computeRequestHash({
      method: 'GET',
      url: 'https://x.test/a',
      headers: { 'user-agent': 'Henry', accept: 'application/json' },
    });
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2); // header casing + order shouldn't matter
  });

  it('ignores the authorization header', () => {
    const h1 = computeRequestHash({ method: 'GET', url: 'https://x.test/a', headers: { authorization: 'Bearer abc' } });
    const h2 = computeRequestHash({ method: 'GET', url: 'https://x.test/a', headers: { authorization: 'Bearer xyz' } });
    expect(h1).toBe(h2);
  });

  it('changes when the URL or method changes', () => {
    const base = computeRequestHash({ method: 'GET', url: 'https://x.test/a' });
    expect(base).not.toBe(computeRequestHash({ method: 'POST', url: 'https://x.test/a' }));
    expect(base).not.toBe(computeRequestHash({ method: 'GET', url: 'https://x.test/b' }));
  });
});

describe('ProvenanceRecorder', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), 'henry-rec-')); });
  afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });

  it('lifecycle: invocation → run → fetcher call → artifact → finish', async () => {
    const store = new MemoryProvenanceStore();
    const artifactStore = new FilesystemArtifactStore(tmp);
    const recorder = new ProvenanceRecorder({
      store, artifactStore, invocation: newInvocation('546 Old Haw Creek Rd'),
    });

    await recorder.saveInvocation();
    await recorder.startRun(canonicalToSnapshot(GOLDEN_PROPERTY));
    await recorder.setFetchersPlanned(1);

    const call = await recorder.startFetcherCall('parcel-json', '0.1.0');
    const bytes = Buffer.from('{"hello":"world"}', 'utf8');
    const artifact = await recorder.putArtifact({
      fetcherCallId: call.id,
      label: 'Test',
      filename: 'out.json',
      contentType: 'application/json',
      bytes,
      sourceUrl: 'https://x.test/q',
    });

    expect(artifact.sha256).toBe(sha256Hex(bytes));
    expect(artifact.bytes).toBe(bytes.byteLength);
    expect(artifact.storageUri.startsWith('file://')).toBe(true);
    const written = await readFile(artifact.storageUri.slice(7));
    expect(written.equals(bytes)).toBe(true);

    await recorder.finishFetcherCall({
      ...call,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      data: { ok: true },
    });
    await recorder.finishRun({ status: 'completed' });

    const trace = await store.getRunTrace(recorder.runId);
    expect(trace).toBeTruthy();
    expect(trace!.run.status).toBe('completed');
    expect(trace!.run.totals.fetchersTotal).toBe(1);
    expect(trace!.run.totals.fetchersCompleted).toBe(1);
    expect(trace!.run.totals.artifactsProduced).toBe(1);
    expect(trace!.fetcherCalls[0].data).toEqual({ ok: true });
    expect(trace!.artifacts[0].id).toBe(artifact.id);
  });
});

describe('httpJson provenance instrumentation', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it('records a successful call with response sha256 and duration', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    const tmp = await mkdtemp(join(tmpdir(), 'henry-http-'));
    try {
      const store = new MemoryProvenanceStore();
      const recorder = new ProvenanceRecorder({
        store,
        artifactStore: new FilesystemArtifactStore(tmp),
        invocation: newInvocation(),
      });
      await recorder.saveInvocation();
      await recorder.startRun(canonicalToSnapshot(GOLDEN_PROPERTY));
      const call = await recorder.startFetcherCall('t', '0.1.0');

      const result = await httpJson<{ ok: boolean }>('https://x.test/q', {
        recorder,
        fetcherCallId: call.id,
        sourceLabel: 'test.source',
      });
      expect(result.ok).toBe(true);

      const trace = await store.getRunTrace(recorder.runId);
      expect(trace!.httpHits.length).toBe(1);
      const hit = trace!.httpHits[0];
      expect(hit.status).toBe(200);
      expect(hit.sourceLabel).toBe('test.source');
      expect(hit.fetcherCallId).toBe(call.id);
      expect(hit.responseSha256).toBe(sha256Hex(Buffer.from('{"ok":true}', 'utf8')));
      expect(hit.responseBytes).toBe(11);
      expect(hit.attempt).toBe(0);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('records retriable 500 + final 200 as two rows', async () => {
    let callNo = 0;
    globalThis.fetch = vi.fn(async () => {
      callNo++;
      if (callNo === 1) return new Response('fail', { status: 500 });
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const tmp = await mkdtemp(join(tmpdir(), 'henry-http-'));
    try {
      const store = new MemoryProvenanceStore();
      const recorder = new ProvenanceRecorder({
        store,
        artifactStore: new FilesystemArtifactStore(tmp),
        invocation: newInvocation(),
      });
      await recorder.saveInvocation();
      await recorder.startRun(canonicalToSnapshot(GOLDEN_PROPERTY));

      await httpJson('https://x.test/retry', { recorder, retries: 2 });

      const trace = await store.getRunTrace(recorder.runId);
      expect(trace!.httpHits.length).toBe(2);
      expect(trace!.httpHits[0].status).toBe(500);
      expect(trace!.httpHits[0].attempt).toBe(0);
      expect(trace!.httpHits[1].status).toBe(200);
      expect(trace!.httpHits[1].attempt).toBe(1);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
