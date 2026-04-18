/**
 * POST /api/fetchers/:id
 *
 * Runs a single named fetcher in isolation. Called in parallel by the Slack
 * handler's fan-out orchestrator so every fetcher gets its own Vercel
 * Function invocation (and its own 300 s limit + memory pool).
 *
 * Request body: { runId, invocationId, property: CanonicalProperty }
 * Response:     { result: FetcherResult }
 *
 * Auth: optional. If HENRY_INTERNAL_TOKEN is set, the caller must send it
 * in the X-Henry-Internal header.
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getFetcher } from '../../src/orchestrator/fetchers.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { ProvenanceRecorder } from '../../src/provenance/recorder.js';
import type { CanonicalProperty, FetcherResult } from '../../src/types.js';
import type { Invocation } from '../../src/provenance/schema.js';
import { log } from '../../src/lib/log.js';

// Leave 35 s buffer before Vercel's 300 s hard limit so we can write
// the error row to Neon and send a proper JSON response.
const FETCHER_TIMEOUT_MS = 265_000;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  // Optional internal auth — skip check when token not configured (local dev)
  const internalToken = process.env.HENRY_INTERNAL_TOKEN;
  if (internalToken && req.headers['x-henry-internal'] !== internalToken) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const fetcherId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const { runId, invocationId, property } = req.body as {
    runId: string;
    invocationId: string;
    property: CanonicalProperty;
  };

  if (!fetcherId || !runId || !invocationId || !property) {
    res.status(400).json({ error: 'missing required fields' });
    return;
  }

  let fetcher;
  try {
    fetcher = getFetcher(fetcherId);
  } catch {
    res.status(404).json({ error: `Unknown fetcher: ${fetcherId}` });
    return;
  }

  // Skip immediately if this fetcher doesn't support the property's county —
  // avoids spinning up a Chrome process just to return skipped.
  if (!fetcher.counties.includes(property.county)) {
    res.status(200).json({
      result: {
        fetcher: fetcherId,
        status: 'skipped',
        files: [],
        error: `County ${property.county} not supported by this fetcher`,
        durationMs: 0,
      } satisfies FetcherResult,
    });
    return;
  }

  let store: Awaited<ReturnType<typeof makeProvenanceStack>>['store'];
  let artifactStore: Awaited<ReturnType<typeof makeProvenanceStack>>['artifactStore'];
  try {
    ({ store, artifactStore } = await makeProvenanceStack());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: `provenance init failed: ${msg}` });
    return;
  }

  // The coordinator (Slack handler) already saved the real Invocation + Run
  // rows in Neon. Here we just need a recorder that writes FetcherCall and
  // Artifact rows against the existing runId.
  const invocationStub: Invocation = {
    id: invocationId,
    trigger: 'slack-slash',
    slackTeamId: null,
    slackUserId: null,
    slackChannelId: null,
    slackChannelName: null,
    slackThreadTs: null,
    rawInput: '',
    createdAt: new Date().toISOString(),
  };

  const recorder = new ProvenanceRecorder({
    store,
    artifactStore,
    invocation: invocationStub,
    runId,
  });

  const outDir = join(tmpdir(), 'henry-runs', runId);
  await mkdir(outDir, { recursive: true });

  const flog = log.child({ runId, fetcherId });
  const t0 = Date.now();
  const call = await recorder.startFetcherCall(fetcherId, '0.1.0');
  const runCtx = { runId, fetcherCallId: call.id, recorder };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('fetcher timeout')), FETCHER_TIMEOUT_MS);

  let result: FetcherResult;
  try {
    result = await fetcher.run({ property, outDir, signal: ac.signal, run: runCtx });
    clearTimeout(timer);

    const status = result.status === 'skipped' ? 'skipped'
      : result.status === 'completed' ? 'completed'
      : 'failed';

    await recorder.finishFetcherCall({
      ...call,
      status,
      error: result.error ?? null,
      data: result.data ?? null,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    });
    flog.info('fetcher_completed', { status, durationMs: Date.now() - t0 });
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    // Distinguish a controlled timeout abort from unexpected errors.
    const isTimeout = ac.signal.aborted || msg.includes('fetcher timeout');
    const callStatus = isTimeout ? 'timeout' : 'failed';
    flog.warn('fetcher_failed', { err: msg, callStatus, durationMs: Date.now() - t0 });
    await recorder.finishFetcherCall({
      ...call,
      status: callStatus,
      error: msg,
      data: null,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    }).catch(() => {});
    result = { fetcher: fetcherId, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
  }

  res.status(200).json({ result, artifacts: recorder.artifacts });
}
