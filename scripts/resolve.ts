#!/usr/bin/env tsx
/**
 * CLI: node scripts/resolve.ts "<address or PIN>"
 *
 * Quick way to verify the resolver is working without spinning up
 * the whole Slack stack.
 */

import { resolveProperty } from '../src/resolver/index.js';

const raw = process.argv.slice(2).join(' ').trim();
if (!raw) {
  console.error('usage: tsx scripts/resolve.ts "<address or PIN>"');
  process.exit(1);
}

try {
  const r = await resolveProperty({ raw, county: 'buncombe' });
  console.log(JSON.stringify({
    pin: r.pin,
    gisPin: r.gisPin,
    address: r.address,
    ownerName: r.ownerName,
    deed: r.deed,
    plat: r.plat,
    centroid: r.centroid,
    confidence: r.confidence,
    source: r.source,
  }, null, 2));
} catch (err) {
  console.error('FAILED:', err instanceof Error ? err.message : String(err));
  process.exit(2);
}
