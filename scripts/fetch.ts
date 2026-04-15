#!/usr/bin/env tsx
/**
 * CLI: tsx scripts/fetch.ts "<address or PIN>"
 *
 * Resolves the property, runs all fetchers, prints progress + a final
 * summary. Mirrors what the Slack bot will do.
 */

import { resolveProperty } from '../src/resolver/index.ts';
import { runFetchers } from '../src/orchestrator/index.ts';
import { ALL_FETCHERS } from '../src/orchestrator/fetchers.ts';
import { join } from 'node:path';
import { cwd } from 'node:process';

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

  const summary = await runFetchers(ALL_FETCHERS, property, {
    outRoot,
    onProgress: (ev) => {
      const suffix = ev.file ? ` → ${ev.file}` : ev.message ? ` ${ev.message}` : '';
      console.error(`[${ev.fetcher}] ${ev.status}${suffix}`);
    },
  });

  console.error('');
  console.error(`[henry] Done in ${summary.durationMs}ms — ${summary.totals.completed}/${summary.totals.total} fetchers OK, ${summary.totals.filesProduced} files`);
  console.error(`[henry] Output dir: ${summary.outDir}`);
  // Print structured summary to stdout (for piping / parsing)
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
} catch (err) {
  console.error('[henry] FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(2);
}
