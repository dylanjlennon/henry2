/**
 * soilSeptic — USDA SSURGO soil data and septic suitability.
 *
 * Two-step approach (the old SDA_Get_Mapunit_from_WktWgs84 / SDA_Get_Mukey_from_WktWgs84
 * spatial functions were removed from the SDA tabular service circa 2024):
 *
 *   STEP 1 — Resolve mukey via WMS GetFeatureInfo:
 *     GET https://sdmdataaccess.sc.egov.usda.gov/Spatial/SDM.wms
 *       SERVICE=WMS&VERSION=1.1.1&REQUEST=GetFeatureInfo
 *       &LAYERS=mapunitpoly&QUERY_LAYERS=mapunitpoly
 *       &SRS=EPSG:4326&BBOX=<lon±0.001>,<lat±0.001>&WIDTH=100&HEIGHT=100
 *       &X=50&Y=50&INFO_FORMAT=text/plain
 *     Returns: areasymbol, musym, mukey, muareaacres, etc.
 *
 *   STEP 2 — Tabular join using the resolved mukey:
 *     POST https://sdmdataaccess.sc.egov.usda.gov/tabular/post.rest
 *     Single SQL query: mapunit → component → top-horizon texture → cointerp septic.
 *     Returns: muname, compname, comppct, top_texture, septic_rating.
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const WMS_URL = 'https://sdmdataaccess.sc.egov.usda.gov/Spatial/SDM.wms';
const SDA_URL = 'https://sdmdataaccess.sc.egov.usda.gov/tabular/post.rest';

export interface SoilSepticData {
  mukey: string | null;
  mapUnitName: string | null;
  componentName: string | null;
  texture: string | null;
  septicRating: string | null;
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
      // Step 1: resolve mukey from WMS GetFeatureInfo
      const mukey = await resolveMukeyFromWms(lon, lat);
      if (!mukey) {
        return { fetcher: this.id, status: 'failed', files: [], error: 'WMS GetFeatureInfo returned no mukey for this location', durationMs: Date.now() - t0 };
      }

      // Step 2: tabular query for soil details using the mukey
      const rows = await querySdaByMukey(mukey);

      let mapUnitName: string | null = null;
      let componentName: string | null = null;
      let texture: string | null = null;
      let septicRating: string | null = null;

      if (rows.length > 0) {
        // Rows ordered by comppct_r DESC — pick major component (first row)
        const row = rows[0];
        mapUnitName = row[0] ?? null;
        componentName = row[1] ?? null;
        texture = row[3] ?? null;
        septicRating = row[4] ?? null;
      }

      const data: SoilSepticData = { mukey, mapUnitName, componentName, texture, septicRating };

      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return {
        fetcher: this.id,
        status: 'completed',
        files: [],
        data: data as unknown as Record<string, unknown>,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    }
  },
};

/**
 * Step 1: Use the USDA SDM WMS GetFeatureInfo to find the mukey for a lat/lon.
 *
 * Constructs a tiny bbox (±0.001 degrees, ~100 m) around the point, renders a
 * 100×100 image, and queries the centre pixel (50, 50).
 *
 * Returns the mukey string, or null if the point falls outside all map units.
 */
async function resolveMukeyFromWms(lon: number, lat: number): Promise<string | null> {
  const delta = 0.001;
  const bbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;
  const params = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetFeatureInfo',
    LAYERS: 'mapunitpoly',
    QUERY_LAYERS: 'mapunitpoly',
    SRS: 'EPSG:4326',
    BBOX: bbox,
    WIDTH: '100',
    HEIGHT: '100',
    X: '50',
    Y: '50',
    INFO_FORMAT: 'text/plain',
  });

  const resp = await fetch(`${WMS_URL}?${params.toString()}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return null;
  const text = await resp.text();

  // Parse the plain-text response:
  //   mukey = '1671993'
  const match = /^\s*mukey\s*=\s*'(\d+)'/m.exec(text);
  return match ? match[1] : null;
}

/**
 * Step 2: Given a mukey, query SDA tabular for:
 *   muname, compname, comppct_r, top-horizon texture, septic rating
 *
 * Returns rows as string[][] with columns:
 *   [0] muname
 *   [1] compname
 *   [2] comppct_r
 *   [3] top_texture
 *   [4] septic_rating
 */
async function querySdaByMukey(mukey: string): Promise<string[][]> {
  const query = `SELECT
    mu.muname,
    co.compname,
    co.comppct_r,
    (SELECT TOP 1 th2.texdesc
     FROM chorizon ch2
     INNER JOIN chtexturegrp th2 ON th2.chkey = ch2.chkey AND th2.rvindicator = 'Yes'
     WHERE ch2.cokey = co.cokey
     ORDER BY ch2.hzdept_r ASC) AS top_texture,
    (SELECT TOP 1 ci2.interphrc
     FROM cointerp ci2
     WHERE ci2.cokey = co.cokey
     AND ci2.mrulename = 'ENG - Septic Tank Absorption Fields'
     AND ci2.seqnum = 1) AS septic_rating
  FROM mapunit mu
  INNER JOIN component co ON co.mukey = mu.mukey
  WHERE mu.mukey = '${mukey}'
  ORDER BY co.comppct_r DESC`;

  const body = new URLSearchParams({ request: 'query', query, format: 'json' });
  const resp = await fetch(SDA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) return [];
  const data = await resp.json() as { Table?: string[][] };
  return data.Table ?? [];
}
