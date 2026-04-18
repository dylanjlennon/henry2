/**
 * adjacentParcels — finds all parcels that share a boundary with this parcel.
 *
 * THREE-STEP APPROACH:
 *   1. Fetch subject parcel polygon geometry from Buncombe FeatureServer/1 by PIN.
 *   2. Use that polygon with esriSpatialRelTouches to find truly adjacent parcels
 *      (not just bounding-box neighbors). Falls back to envelope query if step 1 fails.
 *   3. For each neighbor, resolve zoning code:
 *      - If City == "CAS" (Asheville): query Asheville Zoning_ForUrban5 (services.arcgis.com)
 *      - If unincorporated (City == "BUN" or blank): query Buncombe FeatureServer/5
 *      - Other municipalities: skip zoning (use City label)
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const PARCEL_URL = 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/1/query';
const ASHEVILLE_ZONING_URL = 'https://services.arcgis.com/aJ16ENn1AaqdFlqx/arcgis/rest/services/Zoning_ForUrban5/FeatureServer/0/query';
const BUNCOMBE_ZONING_URL = 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/5/query';

const BUFFER_DEG = 0.0018; // ~200m fallback buffer

export interface AdjacentParcel {
  pin: string;
  owner: string;
  address: string;
  city: string;
  zoningCode: string | null;
}

export const adjacentParcelsFetcher: Fetcher = {
  id: 'adjacent-parcels',
  name: 'Adjacent parcel owners & zoning',
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
    const selfPin = ctx.property.gisPin.replace(/[-\s]/g, '').toUpperCase();

    // Step 1: get subject parcel polygon
    const polygon = await fetchParcelPolygon(selfPin);

    // Step 2: find adjacent parcels (polygon intersects = true boundary-sharing neighbors)
    // Falls back to envelope query if polygon fetch fails.
    const rawNeighbors = polygon
      ? await queryIntersecting(polygon, selfPin)
      : await queryByEnvelope(lon, lat, selfPin);

    if (!rawNeighbors) {
      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return {
        fetcher: this.id, status: 'completed', files: [],
        data: { neighbors: [], count: 0, unavailable: 'GIS server did not respond' },
        durationMs: Date.now() - t0,
      };
    }

    // Step 3: enrich with zoning (batch by jurisdiction)
    const neighbors = await enrichWithZoning(rawNeighbors);

    ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
    return {
      fetcher: this.id,
      status: 'completed',
      files: [],
      data: { neighbors, count: neighbors.length },
      durationMs: Date.now() - t0,
    };
  },
};

interface RawNeighbor {
  pin: string;
  owner: string;
  address: string;
  city: string;
  centroidLon: number | null;
  centroidLat: number | null;
}

async function fetchParcelPolygon(pin: string): Promise<unknown | null> {
  try {
    const params = new URLSearchParams({
      where: `PIN = '${pin}'`,
      outFields: 'PIN',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
    });
    const resp = await fetch(`${PARCEL_URL}?${params}`, { signal: AbortSignal.timeout(12_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { features?: Array<{ geometry: unknown }> };
    return data.features?.[0]?.geometry ?? null;
  } catch {
    return null;
  }
}

async function queryIntersecting(polygon: unknown, selfPin: string): Promise<RawNeighbor[] | null> {
  try {
    const params = new URLSearchParams({
      geometry: JSON.stringify(polygon),
      geometryType: 'esriGeometryPolygon',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'PIN,Owner,Address,City',
      returnGeometry: 'true',
      outSR: '4326',
      returnCentroid: 'true',
      resultRecordCount: '30',
      f: 'json',
    });
    const resp = await fetch(`${PARCEL_URL}?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { features?: Array<{ attributes: Record<string, unknown>; centroid?: { x: number; y: number } }>; error?: unknown };
    if (data.error) return null;
    return parseNeighborFeatures(data.features ?? [], selfPin);
  } catch {
    return null;
  }
}

async function queryByEnvelope(lon: number, lat: number, selfPin: string): Promise<RawNeighbor[] | null> {
  try {
    const envelope = {
      xmin: lon - BUFFER_DEG, ymin: lat - BUFFER_DEG,
      xmax: lon + BUFFER_DEG, ymax: lat + BUFFER_DEG,
      spatialReference: { wkid: 4326 },
    };
    const params = new URLSearchParams({
      geometry: JSON.stringify(envelope),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'PIN,Owner,Address,City',
      returnGeometry: 'true',
      outSR: '4326',
      returnCentroid: 'true',
      resultRecordCount: '25',
      f: 'json',
    });
    const resp = await fetch(`${PARCEL_URL}?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { features?: Array<{ attributes: Record<string, unknown>; centroid?: { x: number; y: number } }>; error?: unknown };
    if (data.error) return null;
    return parseNeighborFeatures(data.features ?? [], selfPin);
  } catch {
    return null;
  }
}

function parseNeighborFeatures(
  features: Array<{ attributes: Record<string, unknown>; centroid?: { x: number; y: number } }>,
  selfPin: string,
): RawNeighbor[] {
  return features
    .map((f) => {
      const a = f.attributes;
      const pin = String(a.PIN ?? '').replace(/[-\s]/g, '').toUpperCase();
      const owner = String(a.Owner ?? '').trim();
      const address = String(a.Address ?? '').trim();
      const city = String(a.City ?? '').trim().toUpperCase();
      return {
        pin, owner, address, city,
        centroidLon: f.centroid?.x ?? null,
        centroidLat: f.centroid?.y ?? null,
      };
    })
    .filter((n) => n.pin && n.pin !== selfPin && n.owner);
}

async function enrichWithZoning(neighbors: RawNeighbor[]): Promise<AdjacentParcel[]> {
  // Split into Asheville vs county parcels (others get null zoning)
  const asheville = neighbors.filter((n) => n.city === 'CAS' && n.centroidLon !== null);
  const county = neighbors.filter((n) => n.city !== 'CAS' && n.centroidLon !== null);

  const [ashevilleZoning, countyZoning] = await Promise.all([
    batchZoning(asheville, ASHEVILLE_ZONING_URL, 'districts'),
    batchZoning(county, BUNCOMBE_ZONING_URL, 'ZoningCode'),
  ]);

  return neighbors.map((n) => {
    const zoning = ashevilleZoning.get(n.pin) ?? countyZoning.get(n.pin) ?? null;
    return { pin: n.pin, owner: n.owner, address: n.address, city: n.city, zoningCode: zoning };
  });
}

async function batchZoning(
  parcels: RawNeighbor[],
  url: string,
  field: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (parcels.length === 0) return result;

  // Query each parcel's centroid in parallel (capped at 10 concurrent)
  const CONCURRENCY = 10;
  for (let i = 0; i < parcels.length; i += CONCURRENCY) {
    const batch = parcels.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (n) => {
        if (n.centroidLon === null || n.centroidLat === null) return;
        const params = new URLSearchParams({
          geometry: `${n.centroidLon},${n.centroidLat}`,
          geometryType: 'esriGeometryPoint',
          inSR: '4326',
          spatialRel: 'esriSpatialRelIntersects',
          outFields: field,
          returnGeometry: 'false',
          f: 'json',
        });
        try {
          const resp = await fetch(`${url}?${params}`, { signal: AbortSignal.timeout(8_000) });
          if (!resp.ok) return;
          const data = await resp.json() as { features?: Array<{ attributes: Record<string, unknown> }> };
          const z = data.features?.[0]?.attributes[field];
          if (z) result.set(n.pin, String(z).trim());
        } catch { /* skip on error */ }
      }),
    );
  }
  return result;
}
