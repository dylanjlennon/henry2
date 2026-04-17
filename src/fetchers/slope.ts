/**
 * slope — elevation and slope from Buncombe County raster services.
 *
 * Two ImageServer/identify calls (pure REST, no browser):
 *   1. DEM (Digital Elevation Model) — EPSG:2264 (NC State Plane feet)
 *      Returns elevation in US Survey Feet.
 *   2. PERCENTSLOPE — EPSG:2264 (NC State Plane feet)
 *      Returns slope as a percentage (0–100+).
 *
 * Both rasters require EPSG:2264 coordinates. The centroid is reprojected
 * via reprojectPoint() before querying.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { reprojectPoint } from '../lib/coordinateTransform.js';

const DEM_URL = 'https://gis.buncombecounty.org/arcgis/rest/services/base/DEM/ImageServer/identify';
const SLOPE_URL = 'https://gis.buncombecounty.org/arcgis/rest/services/base/PERCENTSLOPE/ImageServer/identify';

export interface SlopeData {
  elevationFt: number | null;
  slopePct: number | null;
  slopeDeg: number | null;
}

export const slopeFetcher: Fetcher = {
  id: 'slope',
  name: 'Elevation & slope (Buncombe raster)',
  counties: ['buncombe'],
  estimatedMs: 5_000,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    if (!ctx.property.centroid) {
      return { fetcher: this.id, status: 'skipped', files: [], error: 'No centroid', durationMs: Date.now() - t0 };
    }
    const { lon, lat } = ctx.property.centroid;
    const { xFt, yFt } = reprojectPoint(lon, lat);
    const geom = `${xFt},${yFt}`;

    const [elevResult, slopeResult] = await Promise.allSettled([
      identifyRaster(DEM_URL, geom),
      identifyRaster(SLOPE_URL, geom),
    ]);

    const elevationFt = elevResult.status === 'fulfilled' ? elevResult.value : null;
    const slopePct = slopeResult.status === 'fulfilled' ? slopeResult.value : null;
    const slopeDeg = slopePct !== null ? Math.round(Math.atan(slopePct / 100) * (180 / Math.PI) * 10) / 10 : null;

    const data: SlopeData = { elevationFt, slopePct, slopeDeg };

    ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
    return { fetcher: this.id, status: 'completed', files: [], data: data as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
  },
};

async function identifyRaster(url: string, geom: string): Promise<number | null> {
  const params = new URLSearchParams({
    geometry: geom,
    geometryType: 'esriGeometryPoint',
    inSR: '2264',
    returnGeometry: 'false',
    returnCatalogItems: 'false',
    f: 'json',
  });
  const resp = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) return null;
  const data = await resp.json() as { value?: string; error?: unknown };
  if (data.error || data.value === undefined) return null;
  const val = parseFloat(data.value);
  return isNaN(val) ? null : Math.round(val * 10) / 10;
}
