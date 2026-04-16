#!/usr/bin/env tsx
/**
 * CLI: tsx scripts/fetch.ts "<address or PIN>"
 *
 * Resolves the property, runs all fetchers, prints progress + a final
 * summary. Mirrors what the Slack bot does, including full provenance
 * recording (default backend: in-memory + filesystem, so no DB required).
 */

import { randomUUID } from 'node:crypto';
import { resolveProperty } from '../src/resolver/index.js';
import { runFetchers } from '../src/orchestrator/index.js';
import { ALL_FETCHERS } from '../src/orchestrator/fetchers.js';
import { join } from 'node:path';
import { cwd } from 'node:process';
import { makeProvenanceStack } from '../src/provenance/factory.js';
import { ProvenanceRecorder } from '../src/provenance/recorder.js';
import { canonicalToSnapshot } from '../src/provenance/snapshot.js';

const raw = process.argv.slice(2).join(' ').trim();
if (!raw) {
  console.error('usage: tsx scripts/fetch.ts "<address or PIN>"');
  process.exit(1);
}

const outRoot = process.env.OUT_ROOT ?? join(cwd(), 'tmp', 'runs');

try {
  console.error(`[henry] Resolving: ${raw}`);
  const property = await resolveProperty({ raw, county: 'buncombe' });
  console.error(`[henry] Resolved: ${property.pin} (${property.source}, confidence ${property.confidence.toFixed(2)})`);
  if (property.address) console.error(`[henry] Address: ${property.address}`);
  if (property.ownerName) console.error(`[henry] Owner: ${property.ownerName}`);

  const { store, artifactStore, backendLabel } = await makeProvenanceStack();
  const recorder = new ProvenanceRecorder({
    store,
    artifactStore,
    invocation: {
      id: randomUUID(),
      trigger: 'cli',
      slackTeamId: null,
      slackUserId: null,
      slackChannelId: null,
      slackChannelName: null,
      slackThreadTs: null,
      rawInput: raw,
      createdAt: new Date().toISOString(),
    },
  });
  await recorder.saveInvocation();
  await recorder.startRun(canonicalToSnapshot(property));
  console.error(`[henry] Provenance: ${backendLabel}, runId=${recorder.runId}`);

  let status: 'completed' | 'partial' | 'failed' = 'completed';
  try {
    const summary = await runFetchers(ALL_FETCHERS, property, {
      outRoot,
      recorder,
      onProgress: (ev) => {
        const suffix = ev.file ? ` → ${ev.file}` : ev.message ? ` ${ev.message}` : '';
        console.error(`[${ev.fetcher}] ${ev.status}${suffix}`);
      },
    });
    if (summary.totals.failed > 0) status = summary.totals.completed > 0 ? 'partial' : 'failed';

    console.error('');
    console.error(`[henry] Done in ${summary.durationMs}ms — ${summary.totals.completed}/${summary.totals.total} fetchers OK, ${summary.totals.filesProduced} files`);
    console.error(`[henry] Output dir: ${summary.outDir}`);
    console.log(JSON.stringify(
      {
        runId: summary.runId,
        property: {
          pin: property.pin,
          address: property.address,
          ownerName: property.ownerName,
          deed: property.deed,
          plat: property.plat,
        },
        outDir: summary.outDir,
        totals: summary.totals,
        results: summary.results.map((r) => ({
          fetcher: r.fetcher,
          status: r.status,
          files: r.files.map((f) => f.path),
          data: r.data,
          error: r.error,
          durationMs: r.durationMs,
        })),
      },
      null,
      2,
    ));
  } finally {
    await recorder.finishRun({ status });
  }
} catch (err) {
  console.error('[henry] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(2);
}
