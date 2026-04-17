/**
 * landslideHazard — checks NCGS landslide inventory and Buncombe stability raster.
 *
 * Four data sources:
 *   1. NCGS FeatureServer/0 — historical landslide points within 200 ft of centroid
 *   2. NCGS FeatureServer/1 — slope movement polygons intersecting the parcel
 *   3. NCGS FeatureServer/2 — debris flow deposits intersecting the parcel
 *      (highest value layer — debris flows cause the most property damage)
 *   4. Buncombe StabilityIndexMap ImageServer/identify — raster pixel value
 *      (requires EPSG:32119; 1=Stable, 2=Moderately Unstable, 3=Highly Unstable)
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { reprojectPoint } from '../lib/coordinateTransform.js';

const NCGS_BASE = 'https://services.nconemap.gov/secure/rest/services/NC1Map_Geology/FeatureServer';
const STABILITY_RASTER = 'https://gis.buncombecounty.org/arcgis/rest/services/environmental/StabilityIndexMap/ImageServer';

const STABILITY_LABELS: Record<number, string> = {
  1: 'Stable',
  2: 'Moderately Unstable',
  3: 'Highly Unstable',
};

export interface LandslideHazardData {
  /** Historical landslide points within 200 ft */
  nearbyLandslideCount: number;
  /** Slope movement polygons intersecting the parcel */
  slopeMovementCount: number;
  /** Debris flow deposit polygons intersecting the parcel */
  debrisFlowCount: number;
  /** Buncombe stability raster value (1–3) or null if unavailable */
  stabilityIndex: number | null;
  /** Human-readable stability label */
  stabilityLabel: string | null;
  /** Summary risk level derived from all sources */
  riskLevel: 'none' | 'low' | 'moderate' | 'high';
}

export const landslideHazardFetcher: Fetcher = {
  id: 'landslide-hazard',
  name: 'Landslide hazard (NCGS + Buncombe stability)',
  counties: ['buncombe'],
  estimatedMs: 10_000,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    if (!ctx.property.centroid) {
      return { fetcher: this.id, status: 'skipped', files: [], error: 'No centroid', durationMs: Date.now() - t0 };
    }
    const { lon, lat } = ctx.property.centroid;
    const { xM, yM } = reprojectPoint(lon, lat);

    const geomPoint = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });

    // 200 ft buffer polygon around centroid (in WGS84 degrees, ~0.00055°)
    const bufferDeg = 0.00055;
    const bufferGeom = JSON.stringify({
      xmin: lon - bufferDeg,
      ymin: lat - bufferDeg,
      xmax: lon + bufferDeg,
      ymax: lat + bufferDeg,
      spatialReference: { wkid: 4326 },
    });

    const parcelGeom = ctx.property.geometry
      ? JSON.stringify({ ...ctx.property.geometry as object, spatialReference: { wkid: 4326 } })
      : geomPoint;
    const parcelGeomType = ctx.property.geometry ? 'esriGeometryPolygon' : 'esriGeometryPoint';

    const [landslidePoints, slopeMovement, debrisFlow, stabilityResult] = await Promise.allSettled([
      queryNcgsLayer(0, bufferGeom, 'esriGeometryEnvelope', 'esriSpatialRelIntersects'),
      queryNcgsLayer(1, parcelGeom, parcelGeomType, 'esriSpatialRelIntersects'),
      queryNcgsLayer(2, parcelGeom, parcelGeomType, 'esriSpatialRelIntersects'),
      queryStabilityRaster(xM, yM),
    ]);

    const nearbyLandslideCount = landslidePoints.status === 'fulfilled' ? landslidePoints.value : 0;
    const slopeMovementCount = slopeMovement.status === 'fulfilled' ? slopeMovement.value : 0;
    const debrisFlowCount = debrisFlow.status === 'fulfilled' ? debrisFlow.value : 0;
    const stabilityIndex = stabilityResult.status === 'fulfilled' ? stabilityResult.value : null;
    const stabilityLabel = stabilityIndex !== null ? (STABILITY_LABELS[stabilityIndex] ?? null) : null;

    const riskLevel = deriveRiskLevel(nearbyLandslideCount, slopeMovementCount, debrisFlowCount, stabilityIndex);

    const data: LandslideHazardData = {
      nearbyLandslideCount,
      slopeMovementCount,
      debrisFlowCount,
      stabilityIndex,
      stabilityLabel,
      riskLevel,
    };

    ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
    return { fetcher: this.id, status: 'completed', files: [], data: data as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
  },
};

async function queryNcgsLayer(
  layerId: number,
  geometry: string,
  geometryType: string,
  spatialRel: string,
): Promise<number> {
  const params = new URLSearchParams({
    geometry,
    geometryType,
    inSR: '4326',
    spatialRel,
    outFields: 'OBJECTID',
    returnGeometry: 'false',
    returnCountOnly: 'true',
    f: 'json',
  });
  const resp = await fetch(`${NCGS_BASE}/${layerId}/query?${params}`, { signal: AbortSignal.timeout(12_000) });
  if (!resp.ok) return 0;
  const data = await resp.json() as { count?: number; error?: unknown };
  if (data.error) return 0;
  return data.count ?? 0;
}

async function queryStabilityRaster(xM: number, yM: number): Promise<number | null> {
  const params = new URLSearchParams({
    geometry: `${xM},${yM}`,
    geometryType: 'esriGeometryPoint',
    inSR: '32119',
    returnGeometry: 'false',
    returnCatalogItems: 'false',
    f: 'json',
  });
  const resp = await fetch(`${STABILITY_RASTER}/identify?${params}`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) return null;
  const data = await resp.json() as { value?: string; error?: unknown };
  if (data.error || data.value === undefined) return null;
  const val = parseInt(data.value, 10);
  return isNaN(val) ? null : val;
}

function deriveRiskLevel(
  landslides: number,
  slopeMovements: number,
  debrisFlows: number,
  stability: number | null,
): 'none' | 'low' | 'moderate' | 'high' {
  if (debrisFlows > 0 || slopeMovements > 0 || stability === 3) return 'high';
  if (landslides > 2 || stability === 2) return 'moderate';
  if (landslides > 0) return 'low';
  return 'none';
}
