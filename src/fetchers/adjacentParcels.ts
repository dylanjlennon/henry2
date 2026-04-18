/**
 * adjacentParcels — finds all parcels that share a boundary with this parcel.
 *
 * Uses the Buncombe County parcel layer (FeatureServer/1) with an envelope
 * query around the parcel centroid (±0.0018° ≈ 200m). This avoids sending
 * the full polygon geometry in the URL, which causes failures on this server.
 * Results are filtered to exclude the subject parcel by PIN.
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const PARCEL_URL = 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/1/query';

// ~200m buffer in degrees — catches all adjacent parcels for typical urban/suburban lots
const BUFFER_DEG = 0.0018;

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

    if (!ctx.property.centroid) {
      return { fetcher: this.id, status: 'skipped', files: [], error: 'No centroid', durationMs: Date.now() - t0 };
    }

    const { lon, lat } = ctx.property.centroid;
    const envelope = {
      xmin: lon - BUFFER_DEG,
      ymin: lat - BUFFER_DEG,
      xmax: lon + BUFFER_DEG,
      ymax: lat + BUFFER_DEG,
      spatialReference: { wkid: 4326 },
    };

    const { neighbors, error: queryError } = await queryByEnvelope(envelope, ctx.property.gisPin);

    if (!neighbors) {
      // GIS server unreachable or returned an error — return graceful completed result
      // so the report page shows "unavailable" rather than a hard failure.
      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return {
        fetcher: this.id, status: 'completed', files: [],
        data: { neighbors: [], count: 0, unavailable: queryError ?? 'GIS server did not respond' },
        durationMs: Date.now() - t0,
      };
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

async function queryByEnvelope(
  envelope: { xmin: number; ymin: number; xmax: number; ymax: number; spatialReference: { wkid: number } },
  selfPin: string,
): Promise<{ neighbors: AdjacentParcel[] | null; error?: string }> {
  try {
    const params = new URLSearchParams({
      geometry: JSON.stringify(envelope),
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'PIN,Owner,Address',
      returnGeometry: 'false',
      resultRecordCount: '25',
      f: 'json',
    });
    const resp = await fetch(`${PARCEL_URL}?${params}`, { signal: AbortSignal.timeout(15_000) });
    if (!resp.ok) return { neighbors: null, error: `HTTP ${resp.status}` };
    const data = await resp.json() as { features?: Array<{ attributes: Record<string, unknown> }>; error?: unknown };
    if (data.error) return { neighbors: null, error: JSON.stringify(data.error) };

    const cleanPin = selfPin.replace(/[-\s]/g, '').toUpperCase();
    const neighbors = (data.features ?? [])
      .map((f) => {
        const a = f.attributes;
        const pin = String(a.PIN ?? '').replace(/[-\s]/g, '').toUpperCase();
        const owner = String(a.Owner ?? '').trim();
        const address = String(a.Address ?? '').trim();
        return { pin, owner, address };
      })
      .filter((n) => n.pin && n.pin !== cleanPin && n.owner);
    return { neighbors };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { neighbors: null, error: msg };
  }
}
