/**
 * nationalRiskIndex — FEMA National Risk Index data for this census tract.
 *
 * Source: FEMA NRI FeatureServer (census tract level).
 * Endpoint: https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/
 *            NRI_Table_CensusTracts/FeatureServer/0/query
 *
 * Returns composite risk rating + individual hazard scores for the 18 NRI
 * hazard types. Risk ratings are FEMA's five-tier scale:
 *   Very High / Relatively High / Relatively Moderate / Relatively Low / Very Low
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const NRI_URL = 'https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Census_Tracts/FeatureServer/0/query';

// Field suffix conventions: _RATNG = rating string, _SCORE = numeric score (0–100)
const HAZARD_FIELDS = [
  'AVLN',   // Avalanche
  'CFLD',   // Coastal Flooding
  'CWAV',   // Cold Wave
  'DRGT',   // Drought
  'ERQK',   // Earthquake
  'HAIL',   // Hail
  'HWAV',   // Heat Wave
  'HRCN',   // Hurricane
  'ISTM',   // Ice Storm
  'LNDS',   // Landslide
  'LTNG',   // Lightning
  'RFLD',   // Riverine Flooding
  'SWND',   // Strong Wind
  'TRND',   // Tornado
  'TSUN',   // Tsunami
  'VLCN',   // Volcanic Activity
  'WFIR',   // Wildfire
  'WNTW',   // Winter Weather
] as const;

export interface NriHazardScore {
  hazard: string;
  score: number | null;
  rating: string | null;
}

export interface NationalRiskIndexData {
  tractId: string | null;
  compositeScore: number | null;
  compositeRating: string | null;
  hazards: NriHazardScore[];
  /** Highest-risk hazards (rating = Very High or Relatively High) */
  topHazards: string[];
}

const HAZARD_LABELS: Record<string, string> = {
  AVLN: 'Avalanche', CFLD: 'Coastal Flooding', CWAV: 'Cold Wave',
  DRGT: 'Drought', ERQK: 'Earthquake', HAIL: 'Hail', HWAV: 'Heat Wave',
  HRCN: 'Hurricane', ISTM: 'Ice Storm', LNDS: 'Landslide', LTNG: 'Lightning',
  RFLD: 'Riverine Flooding', SWND: 'Strong Wind', TRND: 'Tornado',
  TSUN: 'Tsunami', VLCN: 'Volcanic Activity', WFIR: 'Wildfire', WNTW: 'Winter Weather',
};

export const nationalRiskIndexFetcher: Fetcher = {
  id: 'national-risk-index',
  name: 'FEMA National Risk Index',
  counties: ['buncombe'],
  estimatedMs: 6_000,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    if (!ctx.property.centroid) {
      return { fetcher: this.id, status: 'skipped', files: [], error: 'No centroid', durationMs: Date.now() - t0 };
    }
    const { lon, lat } = ctx.property.centroid;

    try {
      const scoreFields = HAZARD_FIELDS.map((h) => `${h}_SCORE`);
      const ratingFields = HAZARD_FIELDS.map((h) => `${h}_RATNG`);
      const outFields = [
        'TRACTFIPS', 'RISK_SCORE', 'RISK_RATNG',
        ...scoreFields,
        ...ratingFields,
      ].join(',');

      const params = new URLSearchParams({
        geometry: `${lon},${lat}`,
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        outFields,
        returnGeometry: 'false',
        f: 'json',
      });

      // POST to avoid URL length limit from 36+ outFields
      const resp = await fetch(NRI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: AbortSignal.timeout(12_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as { features?: Array<{ attributes: Record<string, unknown> }>; error?: unknown };
      if (data.error) throw new Error(JSON.stringify(data.error));

      const feat = data.features?.[0];
      if (!feat) {
        const result: NationalRiskIndexData = {
          tractId: null,
          compositeScore: null,
          compositeRating: null,
          hazards: [],
          topHazards: [],
        };
        ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
        return { fetcher: this.id, status: 'completed', files: [], data: result as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
      }

      const a = feat.attributes;
      const tractId = a.TRACTFIPS ? String(a.TRACTFIPS) : null;
      const compositeScore = parseNumeric(a.RISK_SCORE);
      const compositeRating = a.RISK_RATNG ? String(a.RISK_RATNG).trim() : null;

      const hazards: NriHazardScore[] = HAZARD_FIELDS.map((code) => ({
        hazard: HAZARD_LABELS[code] ?? code,
        score: parseNumeric(a[`${code}_SCORE`]),
        rating: a[`${code}_RATNG`] ? String(a[`${code}_RATNG`]).trim() : null,
      }));

      const topHazards = hazards
        .filter((h) => h.rating && /very high|relatively high/i.test(h.rating))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .map((h) => h.hazard);

      const result: NationalRiskIndexData = {
        tractId,
        compositeScore,
        compositeRating,
        hazards,
        topHazards,
      };

      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return { fetcher: this.id, status: 'completed', files: [], data: result as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    }
  },
};

function parseNumeric(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isNaN(n) ? null : Math.round(n * 10) / 10;
}
