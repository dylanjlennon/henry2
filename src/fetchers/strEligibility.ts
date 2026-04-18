/**
 * strEligibility — short-term rental eligibility for Buncombe County / Asheville.
 *
 * TWO paths depending on jurisdiction (from the jurisdiction fetcher result):
 *
 * ASHEVILLE (isAsheville = true):
 *   1. Zoning check — Asheville Zoning_Overlays MapServer (same service as
 *      historicDistrict). Query for the parcel's zoning district and whether
 *      STRs are allowed. STRs are permitted in RS-2 through RM-16, B-1/B-2/B-3,
 *      and MX zones. NOT permitted in RS-1 (single-family residential).
 *   2. Active homestay permit check — Asheville Open Data portal.
 *      GET https://data.ashevillenc.gov/resource/9p5s-f3ip.json?pin_number={PIN}
 *      Returns active permits of type "Homestay".
 *
 * UNINCORPORATED BUNCOMBE:
 *   1. Buncombe County has no STR ordinance as of 2025 — county parcels are
 *      eligible by default (no permit required).
 *   2. Still check the open permits API for any active permits of note.
 *
 * OTHER MUNICIPALITIES:
 *   Return eligible: null (unknown) with a note that their specific rules apply.
 *
 * No browser needed — pure REST.
 */

import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';

const ASHEVILLE_ZONING_SERVER = 'https://arcgis.ashevillenc.gov/arcgis/rest/services/Planning/Zoning_Overlays/MapServer';
const ASHEVILLE_PERMITS_API = 'https://data.ashevillenc.gov/resource/9p5s-f3ip.json';
const JURISDICTION_URL = 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/4/query';

// Zoning districts where STRs (homestays) are explicitly permitted in Asheville
const ASHEVILLE_STR_ALLOWED_ZONES = new Set([
  'RS-2', 'RS-4', 'RS-8', 'RS-MH', 'RM-6', 'RM-8', 'RM-16',
  'B-1', 'B-2', 'B-3', 'B-4', 'CBD',
  'MX', 'MX-1', 'MX-2',
  'OB', 'OI',
  'IN', 'PM',
]);

export interface StrEligibilityData {
  /** Whether STRs appear to be permitted based on zoning */
  eligible: boolean | null;
  /** Human-readable eligibility summary */
  summary: string;
  /** Zoning district code (Asheville only) */
  zoningDistrict: string | null;
  /** Number of active homestay/STR permits found */
  activePermitCount: number;
  /** Active permit numbers if any */
  activePermits: string[];
  /** Which rules apply */
  rulesJurisdiction: string;
}

export const strEligibilityFetcher: Fetcher = {
  id: 'str-eligibility',
  name: 'Short-term rental eligibility',
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
      const jData = await lookupJurisdiction(lon, lat);

      if (jData.isAsheville) {
        // Run zoning + permits in parallel; zoning may fail if Asheville GIS server is unreachable
        const [zoningResult, activePermits] = await Promise.all([
          getAshevilleZoning(lon, lat).catch(() => null),
          getAshevilleHomestayPermits(ctx.property.gisPin).catch(() => [] as string[]),
        ]);
        const zoningDistrict = zoningResult;

        const eligible = zoningDistrict ? ASHEVILLE_STR_ALLOWED_ZONES.has(zoningDistrict.toUpperCase()) : null;
        const summary = zoningDistrict
          ? buildAshevilleSummary(zoningDistrict, eligible, activePermits.length)
          : `City of Asheville — zoning data unavailable, verify with Planning Dept.${activePermits.length > 0 ? ` ${activePermits.length} active homestay permit(s) on file.` : ''}`;

        const data: StrEligibilityData = {
          eligible,
          summary,
          zoningDistrict,
          activePermitCount: activePermits.length,
          activePermits,
          rulesJurisdiction: 'City of Asheville',
        };
        ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
        return { fetcher: this.id, status: 'completed', files: [], data: data as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
      }

      if (jData.isUnincorporated) {
        const activePermits = await getAshevilleHomestayPermits(ctx.property.gisPin).catch(() => [] as string[]);
        const data: StrEligibilityData = {
          eligible: true,
          summary: 'Unincorporated Buncombe County has no STR ordinance — no permit required.',
          zoningDistrict: null,
          activePermitCount: activePermits.length,
          activePermits,
          rulesJurisdiction: 'Unincorporated Buncombe County',
        };
        ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
        return { fetcher: this.id, status: 'completed', files: [], data: data as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
      }

      // Other municipalities
      const jurisdiction = jData.jurisdiction;
      const data: StrEligibilityData = {
        eligible: null,
        summary: `${jurisdiction} — check local ordinances for STR rules.`,
        zoningDistrict: null,
        activePermitCount: 0,
        activePermits: [],
        rulesJurisdiction: jurisdiction,
      };
      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return { fetcher: this.id, status: 'completed', files: [], data: data as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
    } catch (err) {
      // Jurisdiction lookup failed — return graceful partial result
      const data: StrEligibilityData = {
        eligible: null,
        summary: 'Could not determine jurisdiction — verify STR eligibility locally.',
        zoningDistrict: null,
        activePermitCount: 0,
        activePermits: [],
        rulesJurisdiction: 'Unknown',
      };
      ctx.onProgress?.({ fetcher: this.id, status: 'completed' });
      return { fetcher: this.id, status: 'completed', files: [], data: data as unknown as Record<string, unknown>, durationMs: Date.now() - t0 };
    }
  },
};

async function fetchJsonRetry<T>(url: string, timeoutMs: number): Promise<T> {
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

async function getAshevilleZoning(lon: number, lat: number): Promise<string | null> {
  // Discover zoning layer ID (retry on transient failure of arcgis.ashevillenc.gov)
  const rootData = await fetchJsonRetry<{ layers?: Array<{ id: number; name: string }> }>(
    `${ASHEVILLE_ZONING_SERVER}?f=json`, 15_000,
  );
  const layers = rootData.layers ?? [];
  const zoningLayer = layers.find((l) => /^zoning$/i.test(l.name.trim()))
    ?? layers.find((l) => /zoning district/i.test(l.name))
    ?? layers.find((l) => /zoning/i.test(l.name) && !/overlay|historic/i.test(l.name));

  if (!zoningLayer) return null;

  const params = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
  });
  const data = await fetchJsonRetry<{ features?: Array<{ attributes: Record<string, unknown> }>; error?: unknown }>(
    `${ASHEVILLE_ZONING_SERVER}/${zoningLayer.id}/query?${params}`, 15_000,
  );
  if (data.error) return null;

  const feat = data.features?.[0];
  if (!feat) return null;

  const a = feat.attributes;
  return String(
    a.ZONE_CLASS ?? a.ZONING ?? a.ZONE ?? a.ZoneClass ?? a.zone_class ?? '',
  ).trim() || null;
}

async function getAshevilleHomestayPermits(pin: string): Promise<string[]> {
  const cleanPin = pin.replace(/[-\s]/g, '');
  const params = new URLSearchParams({
    pin_number: cleanPin,
    $limit: '50',
  });
  const resp = await fetch(`${ASHEVILLE_PERMITS_API}?${params}`, { signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) return [];
  const records = await resp.json() as Array<Record<string, unknown>>;
  return records
    .filter((r) => /homestay|str|short.?term/i.test(String(r.permit_type ?? r.permittype ?? r.type ?? '')))
    .map((r) => String(r.permit_number ?? r.permitnumber ?? r.permitnum ?? '').trim())
    .filter(Boolean);
}

interface SimpleJurisdiction {
  jurisdiction: string;
  isAsheville: boolean;
  isUnincorporated: boolean;
}

async function lookupJurisdiction(lon: number, lat: number): Promise<SimpleJurisdiction> {
  try {
    const params = new URLSearchParams({
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'DistCode,Description',
      returnGeometry: 'false',
      f: 'json',
    });
    const resp = await fetch(`${JURISDICTION_URL}?${params}`, { signal: AbortSignal.timeout(15_000) });
    const data = await resp.json() as { features?: Array<{ attributes: Record<string, unknown> }>; error?: unknown };
    if (data.error) throw new Error();
    const feat = data.features?.[0];
    const distCode = feat ? String(feat.attributes.DistCode ?? feat.attributes.DISTCODE ?? '').trim() : null;
    const description = feat ? String(feat.attributes.Description ?? feat.attributes.DESCRIPTION ?? '').trim() : null;
    const DIST_CODE_MAP: Record<string, string> = {
      CAS: 'City of Asheville', CMT: 'Town of Montreat', CBM: 'Town of Black Mountain',
      CWV: 'Town of Weaverville', CWF: 'Town of Woodfin', CBF: 'Town of Biltmore Forest',
    };
    const jurisdiction = distCode && DIST_CODE_MAP[distCode]
      ? DIST_CODE_MAP[distCode]
      : description || (feat ? 'Incorporated area' : 'Unincorporated Buncombe County');
    return { jurisdiction, isAsheville: distCode === 'CAS', isUnincorporated: !feat };
  } catch {
    return { jurisdiction: 'Unknown jurisdiction', isAsheville: false, isUnincorporated: false };
  }
}

function buildAshevilleSummary(zone: string | null, eligible: boolean | null, permitCount: number): string {
  if (eligible === null) {
    return zone
      ? `Zoning district ${zone} — STR eligibility unclear, verify with City of Asheville Planning.`
      : 'Could not determine zoning district — verify STR eligibility with City of Asheville Planning.';
  }
  const base = eligible
    ? `Zoning district ${zone} permits short-term rentals (homestay).`
    : `Zoning district ${zone} does NOT permit short-term rentals.`;
  if (permitCount > 0) {
    return `${base} ${permitCount} active homestay permit(s) on file.`;
  }
  return base;
}
