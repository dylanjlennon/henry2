/**
 * Convert a live CanonicalProperty (the resolver's output) into a
 * PropertySnapshot (the frozen shape we persist with a Run).
 *
 * CanonicalProperty has runtime-only fields (geometry, optional deed/plat)
 * and represents "what we know right now." PropertySnapshot flattens it
 * into the exact columns the Postgres `runs` table holds, so you can
 * later query "all runs where pin=X and started_at in the last week"
 * without joins.
 */

import type { CanonicalProperty } from '../types.js';
import type { PropertySnapshot } from './schema.js';

export function canonicalToSnapshot(p: CanonicalProperty): PropertySnapshot {
  return {
    county: p.county,
    pin: p.pin,
    gisPin: p.gisPin,
    address: p.address ?? null,
    ownerName: p.ownerName ?? null,
    centroidLon: p.centroid?.lon ?? null,
    centroidLat: p.centroid?.lat ?? null,
    deedBook: p.deed?.book ?? null,
    deedPage: p.deed?.page ?? null,
    platBook: p.plat?.book ?? null,
    platPage: p.plat?.page ?? null,
    resolutionSource: p.source,
    resolutionConfidence: p.confidence,
  };
}
