/**
 * soilSeptic — USDA SSURGO soil data and septic suitability.
 *
 * Two queries via the USDA Soil Data Access (SDA) REST endpoint:
 *
 *   QUERY 1 — Map unit at centroid (tabular/SoilWeb):
 *     POST to https://sdmdataaccess.sc.egov.usda.gov/tabular/post.rest
 *     Returns the soil map unit name, component name, and texture for the
 *     point intersection.
 *
 *   QUERY 2 — Septic suitability (onsite wastewater):
 *     Same endpoint. Joins mapunit → component → cointerp for
 *     "Sewage disposal" interpretation.
 *     Returns the limitation rating: Not limited / Somewhat limited / Very limited.
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const SDA_URL = 'https://sdmdataaccess.sc.egov.usda.gov/tabular/post.rest';

export interface SoilSepticData {
  mapUnitName: string | null;
  componentName: string | null;
  texture: string | null;
  septicRating: string | null;
  /** Raw limitation value from SSURGO */
  septicLimitation: string | null;
}

export const soilSepticFetcher: Fetcher = {
  id: 'soil-septic',
  name: 'Soil & septic suitability (SSURGO)',
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

    try {
      const [mapUnitResult, septicResult] = await Promise.allSettled([
        querySda(buildMapUnitQuery(lon, lat)),
        querySda(buildSepticQuery(lon, lat)),
      ]);

      let mapUnitName: string | null = null;
      let componentName: string | null = null;
      let texture: string | null = null;
      if (mapUnitResult.status === 'fulfilled' && mapUnitResult.value.length > 0) {
        const row = mapUnitResult.value[0];
        mapUnitName = row[0] ?? null;
        componentName = row[1] ?? null;
        texture = row[2] ?? null;
      }

      let septicRating: string | null = null;
      let septicLimitation: string | null = null;
      if (septicResult.status === 'fulfilled' && septicResult.value.length > 0) {
        const row = septicResult.value[0];
        septicLimitation = row[0] ?? null;
        septicRating = formatSepticRating(septicLimitation);
      }

      const data: SoilSepticData = { mapUnitName, componentName, texture, septicRating, septicLimitation };

      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return { fetcher: this.id, status: 'completed', files: [], data: data as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    }
  },
};

function buildMapUnitQuery(lon: number, lat: number): string {
  return `SELECT mu.muname, co.compname, co.texdesc
FROM mapunit mu
INNER JOIN component co ON co.mukey = mu.mukey AND co.majcompflag = 'Yes'
INNER JOIN SDA_Get_Mapunit_from_WktWgs84('POINT(${lon} ${lat})') m ON m.mukey = mu.mukey
ORDER BY co.comppct_r DESC`;
}

function buildSepticQuery(lon: number, lat: number): string {
  return `SELECT TOP 1 ci.interphr
FROM component co
INNER JOIN cointerp ci ON ci.cokey = co.cokey
  AND ci.mrulename = 'Sewage disposal'
  AND ci.seqnum = 0
INNER JOIN mapunit mu ON mu.mukey = co.mukey
INNER JOIN SDA_Get_Mapunit_from_WktWgs84('POINT(${lon} ${lat})') m ON m.mukey = mu.mukey
WHERE co.majcompflag = 'Yes'
ORDER BY co.comppct_r DESC`;
}

async function querySda(query: string): Promise<string[][]> {
  const body = new URLSearchParams({ query, format: 'JSON+COLUMNNAMES', p_type: 'JSON+COLUMNNAMES' });
  const resp = await fetch(SDA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return [];
  const data = await resp.json() as { Table?: string[][] } | string[][];
  // SDA returns either { Table: [[row...], ...] } or raw array
  const rows: string[][] = Array.isArray(data) ? data : ((data as { Table?: string[][] }).Table ?? []);
  // First row is column names — skip it
  return rows.slice(1);
}

function formatSepticRating(limitation: string | null): string | null {
  if (!limitation) return null;
  const l = limitation.toLowerCase();
  if (l.includes('not limited') || l === '0') return 'Not limited';
  if (l.includes('somewhat') || l === '1') return 'Somewhat limited';
  if (l.includes('very') || l === '2') return 'Very limited';
  return limitation;
}
