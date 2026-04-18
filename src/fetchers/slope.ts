/**
 * slope — elevation and slope from USGS 3DEP (3D Elevation Program).
 *
 * Queries the USGS Elevation Point Query Service for the parcel centroid and
 * four surrounding points (~100 m in each cardinal direction). Slope is
 * derived from the maximum elevation change across adjacent sample pairs.
 *
 * The Buncombe County DEM/PERCENTSLOPE ImageServers require an auth token
 * and are not publicly accessible, so USGS 3DEP is the public alternative.
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';

// ~100 m in decimal degrees at lat 35.6°
const DELTA_LAT = 0.0009;   // 100 m north/south
const DELTA_LON = 0.00111;  // 100 m east/west (adjusted for latitude)

export interface SlopeData {
  elevationFt: number | null;
  slopePct: number | null;
  slopeDeg: number | null;
}

export const slopeFetcher: Fetcher = {
  id: 'slope',
  name: 'Elevation & slope (USGS 3DEP)',
  counties: ['buncombe'],
  estimatedMs: 8_000,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    if (!ctx.property.centroid) {
      return { fetcher: this.id, status: 'skipped', files: [], error: 'No centroid', durationMs: Date.now() - t0 };
    }
    const { lon, lat } = ctx.property.centroid;

    // Query center + 4 cardinal points to compute slope
    const [center, north, south, east, west] = await Promise.all([
      queryElevation(lon, lat),
      queryElevation(lon, lat + DELTA_LAT),
      queryElevation(lon, lat - DELTA_LAT),
      queryElevation(lon + DELTA_LON, lat),
      queryElevation(lon - DELTA_LON, lat),
    ]);

    const elevationFt = center;

    let slopePct: number | null = null;
    if (center !== null && north !== null && south !== null && east !== null && west !== null) {
      const DIST_FT = 328.084; // 100 m in feet
      const dzNS = Math.abs(north - south) / (2 * DIST_FT);
      const dzEW = Math.abs(east - west) / (2 * DIST_FT);
      const gradient = Math.sqrt(dzNS * dzNS + dzEW * dzEW);
      slopePct = Math.round(gradient * 100 * 10) / 10;
    }
    const slopeDeg = slopePct !== null
      ? Math.round(Math.atan(slopePct / 100) * (180 / Math.PI) * 10) / 10
      : null;

    const data: SlopeData = { elevationFt, slopePct, slopeDeg };
    ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
    return { fetcher: this.id, status: 'completed', files: [], data: data as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
  },
};

async function queryElevation(lon: number, lat: number): Promise<number | null> {
  const params = new URLSearchParams({
    x: String(lon),
    y: String(lat),
    units: 'Feet',
    wkid: '4326',
    includeDate: 'false',
  });
  try {
    const resp = await fetch(`${EPQS_URL}?${params}`, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { value?: number };
    const v = data.value;
    if (v === undefined || v === null || isNaN(Number(v))) return null;
    return Math.round(Number(v) * 10) / 10;
  } catch {
    return null;
  }
}
