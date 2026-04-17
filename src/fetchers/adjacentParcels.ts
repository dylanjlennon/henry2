/**
 * adjacentParcels — finds all parcels that share a boundary with this parcel.
 *
 * Uses the Buncombe County parcel layer (FeatureServer/1) with a spatial
 * esriSpatialRelTouches query against the resolved parcel's own polygon.
 * Returns owner names, PINs, and addresses for every touching parcel.
 *
 * No browser needed — pure REST.
 *
 * FLOW:
 *   1. The resolved CanonicalProperty already carries geometry (polygon rings)
 *      from the initial parcel lookup.
 *   2. POST to FeatureServer/1 with geometryType=esriGeometryPolygon,
 *      spatialRel=esriSpatialRelTouches, outFields=PIN,OwnerName,PropAddr.
 *   3. Filter out the parcel itself (same PIN).
 *   4. Return structured data: list of { pin, owner, address }.
 *
 * FALLBACK:
 *   If the resolved property has no geometry, or if spatialRel=Touches
 *   returns an error (some ESRI deployments don't support it), retry with
 *   spatialRel=esriSpatialRelIntersects using a 1-ft buffer on the polygon,
 *   then filter out the subject parcel.
 *
 * WHAT CAN BREAK:
 *   - geometry may be null if resolver used address-only path with no polygon
 *   - OwnerName field name varies (OwnerName vs OwnerName1 vs Owner)
 *   - Condo common-area parcels (PIN contains "C") show up as neighbors — included
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const PARCEL_URL = 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/1/query';

export interface AdjacentParcel {
  pin: string;
  owner: string;
  address: string;
}

export const adjacentParcelsFetcher: Fetcher = {
  id: 'adjacent-parcels',
  name: 'Adjacent parcel owners',
  counties: ['buncombe'],
  estimatedMs: 5_000,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    const geom = ctx.property.geometry;
    if (!geom) {
      return {
        fetcher: this.id,
        status: 'skipped',
        files: [],
        error: 'No parcel geometry available',
        durationMs: Date.now() - t0,
      };
    }

    const geometryJson = JSON.stringify({ ...geom as object, spatialReference: { wkid: 4326 } });
    const neighbors = await queryNeighbors(geometryJson, ctx.property.gisPin, 'esriSpatialRelTouches')
      ?? await queryNeighbors(geometryJson, ctx.property.gisPin, 'esriSpatialRelIntersects');

    if (!neighbors) {
      return { fetcher: this.id, status: 'failed', files: [], error: 'GIS spatial query failed', durationMs: Date.now() - t0 };
    }

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

async function queryNeighbors(
  geometryJson: string,
  selfPin: string,
  spatialRel: string,
): Promise<AdjacentParcel[] | null> {
  try {
    const params = new URLSearchParams({
      geometry: geometryJson,
      geometryType: 'esriGeometryPolygon',
      inSR: '4326',
      spatialRel,
      outFields: 'PIN,PINNUM,OwnerName,OwnerName1,Owner,PropAddr,PropertyAddress',
      returnGeometry: 'false',
      resultRecordCount: '20',
      f: 'json',
    });
    const resp = await fetch(`${PARCEL_URL}?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as { features?: Array<{ attributes: Record<string, unknown> }>; error?: unknown };
    if (data.error) return null;

    const cleanPin = selfPin.replace(/[-\s]/g, '').toUpperCase();
    return (data.features ?? [])
      .map((f) => {
        const a = f.attributes;
        const pin = String(a.PIN ?? a.PINNUM ?? '').replace(/[-\s]/g, '').toUpperCase();
        const owner = String(a.OwnerName ?? a.OwnerName1 ?? a.Owner ?? '').trim();
        const address = String(a.PropAddr ?? a.PropertyAddress ?? '').trim();
        return { pin, owner, address };
      })
      .filter((n) => n.pin && n.pin !== cleanPin && n.owner);
  } catch {
    return null;
  }
}
