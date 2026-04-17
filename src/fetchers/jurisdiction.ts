/**
 * jurisdiction — determines which municipality (if any) a parcel sits in.
 *
 * Source: Buncombe County opendata FeatureServer/4 — Incorporated Areas.
 * Returns one feature if inside a municipality; empty if unincorporated.
 *
 * This result is consumed by strEligibility (Layer 2) to determine which
 * STR rules apply. It's also surfaced directly in the Property Context output.
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const JURISDICTION_URL = 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/4/query';

const DIST_CODE_MAP: Record<string, string> = {
  CAS: 'City of Asheville',
  CMT: 'Town of Montreat',
  CBM: 'Town of Black Mountain',
  CWV: 'Town of Weaverville',
  CWF: 'Town of Woodfin',
  CBF: 'Town of Biltmore Forest',
};

export interface JurisdictionData {
  jurisdiction: string;
  distCode: string | null;
  isAsheville: boolean;
  isUnincorporated: boolean;
}

export const jurisdictionFetcher: Fetcher = {
  id: 'jurisdiction',
  name: 'Jurisdiction (city limits)',
  counties: ['buncombe'],
  estimatedMs: 3_000,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    if (!ctx.property.centroid) {
      return { fetcher: this.id, status: 'skipped', files: [], error: 'No centroid', durationMs: Date.now() - t0 };
    }
    const { lon, lat } = ctx.property.centroid;

    try {
      const params = new URLSearchParams({
        geometry: `${lon},${lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: '*',
        returnGeometry: 'false',
        f: 'json',
      });
      const resp = await fetch(`${JURISDICTION_URL}?${params}`, { signal: AbortSignal.timeout(10_000) });
      const data = await resp.json() as { features?: Array<{ attributes: Record<string, unknown> }>; error?: unknown };
      if (data.error) throw new Error(JSON.stringify(data.error));

      const feat = data.features?.[0];
      const distCode = feat ? String(feat.attributes.DistCode ?? feat.attributes.DISTCODE ?? '').trim() : null;
      const description = feat ? String(feat.attributes.Description ?? feat.attributes.DESCRIPTION ?? '').trim() : null;
      const jurisdiction = distCode && DIST_CODE_MAP[distCode]
        ? DIST_CODE_MAP[distCode]
        : description || (feat ? 'Incorporated area' : 'Unincorporated Buncombe County');

      const result: JurisdictionData = {
        jurisdiction,
        distCode: distCode || null,
        isAsheville: distCode === 'CAS',
        isUnincorporated: !feat,
      };

      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return { fetcher: this.id, status: 'completed', files: [], data: result as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    }
  },
};
