/**
 * Registry of all available fetchers. Import from here rather than from
 * individual fetcher modules, so we have one spot to enable/disable things.
 */

import type { Fetcher } from '../types.ts';
import { parcelJsonFetcher } from '../fetchers/parcelJson.ts';
import { femaFloodFetcher } from '../fetchers/femaFlood.ts';
import { septicFetcher } from '../fetchers/septic.ts';

export const ALL_FETCHERS: Fetcher[] = [
  parcelJsonFetcher,
  femaFloodFetcher,
  septicFetcher,
  // TODO: browser fetchers (tax bill PDF, PRC PDF, deed, plat, GIS map, FIRMette)
];

/** Get a fetcher by id, or throw. */
export function getFetcher(id: string): Fetcher {
  const f = ALL_FETCHERS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown fetcher: ${id}`);
  return f;
}
