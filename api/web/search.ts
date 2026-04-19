/**
 * POST /api/web/search
 *
 * Public entry point for the Henry web UI.
 *
 * Body: { address: string }
 *
 * Returns: { runId, pin, address, confidence, estimatedMs }
 *   immediately (< 500 ms), then uses waitUntil() to run all 12 fetchers
 *   in the background. The client polls /api/web/status/:id for progress.
 *
 * Rate limiting: 5 runs per IP per hour, enforced via ip_hash in Neon.
 * Scope: Buncombe County only — non-Buncombe addresses return 422.
 */

import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { resolveProperty, ResolveError, type ResolveErrorCode } from '../../src/resolver/index.js';
import { ALL_FETCHERS } from '../../src/orchestrator/fetchers.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { ProvenanceRecorder } from '../../src/provenance/recorder.js';
import { canonicalToSnapshot } from '../../src/provenance/snapshot.js';
import { log } from '../../src/lib/log.js';
import type { Invocation, Artifact } from '../../src/provenance/schema.js';
import type { FetcherResult } from '../../src/types.js';

const OUT_ROOT = process.env.OUT_ROOT ?? join(tmpdir(), 'henry-runs');
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function getBaseUrl(): string | null {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return null;
}

function hashIp(req: VercelRequest): string {
  const raw =
    (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
    (req.socket?.remoteAddress ?? 'unknown');
  return createHash('sha256').update(raw).digest('hex');
}

function collectMetadata(req: VercelRequest) {
  const h = (key: string) => (req.headers[key] as string | undefined) ?? null;
  return {
    userAgent: h('user-agent'),
    country: h('x-vercel-ip-country'),
    city: h('x-vercel-ip-city'),
    referer: h('referer') ?? h('referrer'),
    acceptLanguage: h('accept-language'),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const body = req.body as { address?: unknown };
  const address = typeof body?.address === 'string' ? body.address.trim() : '';
  if (!address) {
    res.status(400).json({ error: 'address is required' });
    return;
  }

  const ipHash = hashIp(req);
  const metadata = collectMetadata(req);
  const stack = await makeProvenanceStack();

  // Rate limiting
  const recent = await stack.store.countRecentWebRunsByIp(ipHash, RATE_WINDOW_MS);
  if (recent >= RATE_LIMIT) {
    res.status(429).json({
      error: `Rate limit reached — max ${RATE_LIMIT} searches per hour. Try again later.`,
    });
    return;
  }

  // Resolve address before ACKing — fast (~300ms) and lets us return the PIN.
  let property;
  try {
    property = await resolveProperty({ raw: address, county: 'buncombe' });
  } catch (err) {
    if (err instanceof ResolveError) {
      res.status(422).json({ error: err.message, code: err.code });
    } else {
      res.status(422).json({
        error: 'Could not resolve this address in Buncombe County, NC. Henry currently covers Buncombe County only — try a full street address like "546 Old Haw Creek Rd" or a 15-digit PIN.',
        code: 'address_not_found' as ResolveErrorCode,
      });
    }
    return;
  }

  // Create provenance records
  const invocation: Invocation = {
    id: randomUUID(),
    trigger: 'web',
    slackTeamId: null,
    slackUserId: null,
    slackChannelId: null,
    slackChannelName: null,
    slackThreadTs: null,
    rawInput: address,
    createdAt: new Date().toISOString(),
    ipHash,
    metadata,
  };
  const recorder = new ProvenanceRecorder({
    store: stack.store,
    artifactStore: stack.artifactStore,
    invocation,
  });
  await recorder.saveInvocation();
  await recorder.startRun(canonicalToSnapshot(property));

  // ACK immediately with runId + resolved property
  res.status(202).json({
    runId: recorder.runId,
    pin: property.pin,
    address: property.address ?? address,
    ownerName: property.ownerName ?? null,
    confidence: property.confidence,
    estimatedMs: 150_000,
  });

  // Run all fetchers in background via waitUntil
  const baseUrl = getBaseUrl();
  waitUntil(runWebFanOut(recorder, property, stack.artifactStore, baseUrl));
}

async function runWebFanOut(
  recorder: ProvenanceRecorder,
  property: import('../../src/types.js').CanonicalProperty,
  _artifactStore: import('../../src/provenance/store.js').ArtifactStore,
  baseUrl: string | null,
): Promise<void> {
  const hlog = log.child({ runId: recorder.runId, source: 'web' });
  let runStatus: 'completed' | 'partial' | 'failed' = 'completed';

  try {
    const active = ALL_FETCHERS.filter((f) => f.counties.includes(property.county));
    await recorder.setFetchersPlanned(active.length);

    let results: FetcherResult[];

    if (baseUrl) {
      const internalToken = process.env.HENRY_INTERNAL_TOKEN;
      results = await Promise.all(
        active.map(async (f): Promise<FetcherResult> => {
          try {
            const resp = await fetch(`${baseUrl}/api/fetchers/${f.id}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(internalToken ? { 'x-henry-internal': internalToken } : {}),
              },
              body: JSON.stringify({
                runId: recorder.runId,
                invocationId: recorder.invocation.id,
                property,
              }),
              signal: AbortSignal.timeout(280_000),
            });
            if (!resp.ok) throw new Error(`fetcher HTTP ${resp.status}`);
            const data = (await resp.json()) as { result: FetcherResult; artifacts?: Artifact[] };
            return data.result;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            hlog.warn('web_fanout_fetcher_failed', { fetcherId: f.id, err: msg });
            return { fetcher: f.id, status: 'failed', files: [], error: msg, durationMs: 0 };
          }
        }),
      );
    } else {
      // Local dev: in-process fallback
      const { runFetchers } = await import('../../src/orchestrator/index.js');
      const summary = await runFetchers(ALL_FETCHERS, property, {
        outRoot: OUT_ROOT,
        recorder,
        browserConcurrency: 2,
        fetcherTimeoutMs: 180_000,
      });
      results = summary.results;
    }

    recorder.setFetcherResultTotals(results);
    const failed = results.filter((r) => r.status === 'failed').length;
    const completed = results.filter((r) => r.status === 'completed').length;
    if (failed > 0) runStatus = completed > 0 ? 'partial' : 'failed';
  } catch (err) {
    runStatus = 'failed';
    hlog.error('web_run_error', { err: String(err) });
  } finally {
    try {
      await recorder.finishRun({ status: runStatus });
    } catch (e) {
      await new Promise((r) => setTimeout(r, 2_000));
      await recorder.finishRun({ status: runStatus }).catch((e2) =>
        hlog.error('finish_run_failed', { err: String(e2) }),
      );
    }
    hlog.info('web_run_closed', { status: runStatus });
  }
}
