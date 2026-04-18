/**
 * historicDistrict — checks whether a parcel is in a local historic district.
 *
 * Source: City of Asheville Planning — Zoning & Overlays MapServer.
 *
 * FLOW:
 *   1. GET the MapServer root (?f=json) to find the current layer ID for
 *      "Historic District Overlay" (Asheville renumbers occasionally).
 *   2. Spatial-intersect at the parcel centroid against that layer.
 *   3. Return district name if found, null if not.
 *
 * Note: Local historic district (requires HPC Certificate of Appropriateness
 * for exterior changes) is DIFFERENT from National Register of Historic Places
 * (honorary, tax credits, no local restrictions). Henry surfaces both distinctions.
 *
 * No browser needed — pure REST.
 * Only returns data for properties inside Asheville city limits; parcels outside
 * skip gracefully (the Asheville GIS service only covers city jurisdiction).
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

async function fetchWithRetry<T>(url: string, timeoutMs: number): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json() as T;
    } catch (err) {
      if (attempt === 1) throw err;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
  throw new Error('unreachable');
}

const ZONING_MAPSERVER = 'https://arcgis.ashevillenc.gov/arcgis/rest/services/Planning/Zoning_Overlays/MapServer';

export interface HistoricDistrictData {
  inLocalHistoricDistrict: boolean;
  districtName: string | null;
  /** Raw layer name confirmed from server */
  layerChecked: string;
}

export const historicDistrictFetcher: Fetcher = {
  id: 'historic-district',
  name: 'Historic district overlay (Asheville)',
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

    try {
      // Step 1: discover current layer ID for Historic District Overlay (retry once on failure)
      const rootData = await fetchWithRetry<{ layers?: Array<{ id: number; name: string }> }>(
        `${ZONING_MAPSERVER}?f=json`, 15_000,
      );
      const layers = rootData.layers ?? [];
      const historicLayer = layers.find((l) =>
        /historic/i.test(l.name) && /district|overlay/i.test(l.name),
      ) ?? layers.find((l) => /historic/i.test(l.name));

      if (!historicLayer) {
        const result: HistoricDistrictData = {
          inLocalHistoricDistrict: false,
          districtName: null,
          layerChecked: 'not-found',
        };
        return { fetcher: this.id, status: 'completed', files: [], data: result as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
      }

      // Step 2: spatial query (retry once on failure)
      const params = new URLSearchParams({
        geometry: `${lon},${lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: '*',
        returnGeometry: 'false',
        f: 'json',
      });
      const qData = await fetchWithRetry<{ features?: Array<{ attributes: Record<string, unknown> }>; error?: unknown }>(
        `${ZONING_MAPSERVER}/${historicLayer.id}/query?${params}`, 15_000,
      );
      if (qData.error) throw new Error(JSON.stringify(qData.error));

      const feat = qData.features?.[0];
      const districtName = feat
        ? String(feat.attributes.NAME ?? feat.attributes.DISTRICT ?? feat.attributes.OVERLAY_NAME ?? feat.attributes.DISTNAME ?? '').trim() || historicLayer.name
        : null;

      const result: HistoricDistrictData = {
        inLocalHistoricDistrict: !!feat,
        districtName,
        layerChecked: historicLayer.name,
      };

      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return { fetcher: this.id, status: 'completed', files: [], data: result as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    }
  },
};
