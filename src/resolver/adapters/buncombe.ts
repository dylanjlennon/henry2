/**
 * Buncombe County, NC GIS adapter.
 *
 * Two REST endpoints:
 *   - Parcel layer (FeatureServer/1): authoritative property record by PIN
 *   - Address points (FeatureServer/2): address → PIN lookup
 *
 * Coordinates are stored in EPSG:2264 (NC State Plane, US Survey Feet);
 * we ask the server to project to EPSG:4326 (WGS84 lon/lat) via outSR.
 */

import { httpJson } from '../../lib/http.js';
import type { ProvenanceRecorder } from '../../provenance/recorder.js';
import type { NormalizedAddress } from '../normalizeAddress.js';

/** Optional provenance hooks — when present, every HTTP hit gets recorded. */
export interface GisQueryOptions {
  recorder?: ProvenanceRecorder;
  fetcherCallId?: string | null;
}

const PARCEL_URL =
  'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/1/query';
const ADDRESS_URL =
  'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/2/query';

interface ArcGisResponse<T> {
  features?: Array<{ attributes: T; geometry?: unknown }>;
  error?: { code: number; message: string };
}

export interface ParcelAttributes {
  PIN: string;
  PINNUM?: string;
  OwnerName?: string;
  OwnerName1?: string;
  PropAddr?: string;
  PropertyAddress?: string;
  DeedBook?: string;
  DeedPage?: string;
  PlatBook?: string;
  PlatPage?: string;
  [key: string]: unknown;
}

export interface AddressAttributes {
  FullCivicAddress?: string;
  ADDRESS?: string;
  HouseNumber?: string | number;
  StreetName?: string;
  StreetType?: string;
  PreDirection?: string;
  PostDirection?: string;
  PIN?: string;
  PINNUM?: string;
  [key: string]: unknown;
}

export interface ParcelHit {
  attributes: ParcelAttributes;
  geometry?: unknown;
  centroid?: { lon: number; lat: number };
}

export interface AddressHit {
  attributes: AddressAttributes;
  centroid?: { lon: number; lat: number };
}

/** Look up a parcel by its 15-digit GIS PIN. */
export async function lookupParcelByPin(
  gisPin: string,
  opts: GisQueryOptions = {},
): Promise<ParcelHit | null> {
  // The PIN field type varies by deployment — sometimes string, sometimes
  // numeric. Try several WHERE shapes until one returns a feature.
  const numericPin = Number.isSafeInteger(Number(gisPin)) ? Number(gisPin) : null;
  const wheres = [
    `PIN='${gisPin}'`,
    `PINNUM='${gisPin}'`,
    ...(numericPin !== null ? [`PIN=${numericPin}`, `PINNUM=${numericPin}`] : []),
  ];
  for (const where of wheres) {
    const url = `${PARCEL_URL}?${new URLSearchParams({
      where,
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
    })}`;
    try {
      const data = await httpJson<ArcGisResponse<ParcelAttributes>>(url, {
        recorder: opts.recorder,
        fetcherCallId: opts.fetcherCallId ?? null,
        sourceLabel: 'buncombe.parcel',
      });
      if (data.error) continue;
      const f = data.features?.[0];
      if (f) return { attributes: f.attributes, geometry: f.geometry, centroid: pickCentroid(f.geometry) };
    } catch {
      // try next form
    }
  }
  return null;
}

/**
 * Spatial query: given a lon/lat, find the parcel that contains the point.
 * Used when the address-point layer doesn't carry a PIN directly — we use
 * the address point's geometry to find which parcel it sits inside.
 */
export async function lookupParcelByPoint(
  lon: number,
  lat: number,
  opts: GisQueryOptions = {},
): Promise<ParcelHit | null> {
  const geometry = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });
  const url = `${PARCEL_URL}?${new URLSearchParams({
    where: '1=1',
    geometry,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  })}`;
  const data = await httpJson<ArcGisResponse<ParcelAttributes>>(url, {
    recorder: opts.recorder,
    fetcherCallId: opts.fetcherCallId ?? null,
    sourceLabel: 'buncombe.parcel',
  });
  if (data.error) throw new Error(`GIS parcel spatial error: ${data.error.message}`);
  const f = data.features?.[0];
  if (!f) return null;
  return { attributes: f.attributes, geometry: f.geometry, centroid: pickCentroid(f.geometry) };
}

/**
 * Search the address layer using the normalized address.
 * We try multiple query forms and several WHERE-clause shapes until something hits.
 */
export async function searchAddress(
  normalized: NormalizedAddress,
  opts: GisQueryOptions = {},
): Promise<AddressHit[]> {
  const attempts: string[] = [];

  // Best query: house number + street name + type, anchored to FullCivicAddress
  for (const form of normalized.queryForms) {
    if (!form) continue;
    const safe = form.replace(/'/g, "''");
    attempts.push(`UPPER(FullCivicAddress) LIKE '${safe}%'`);
    attempts.push(`UPPER(FullCivicAddress) LIKE '%${safe}%'`);
  }

  // Structured fallback: filter by HouseNumber AND StreetName fields
  if (normalized.houseNumber && normalized.streetName) {
    const hn = normalized.houseNumber;
    const sn = normalized.streetName.replace(/'/g, "''");
    attempts.push(
      `HouseNumber='${hn}' AND UPPER(StreetName)='${sn}'`,
    );
    attempts.push(
      `HouseNumber=${Number.isFinite(Number(hn)) ? Number(hn) : 0} AND UPPER(StreetName)='${sn}'`,
    );
  }

  for (const where of attempts) {
    const url = `${ADDRESS_URL}?${new URLSearchParams({
      where,
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
      resultRecordCount: '20',
    })}`;
    try {
      const data = await httpJson<ArcGisResponse<AddressAttributes>>(url, {
        recorder: opts.recorder,
        fetcherCallId: opts.fetcherCallId ?? null,
        sourceLabel: 'buncombe.address',
      });
      if (data.error) continue; // try next form
      const features = data.features ?? [];
      if (features.length > 0) {
        return features.map((f) => ({
          attributes: f.attributes,
          centroid: pickCentroid(f.geometry),
        }));
      }
    } catch {
      // try next form
    }
  }
  return [];
}

/**
 * Look up a specific condo/townhome unit by street address + unit number.
 *
 * Queries the parcel layer directly using HouseNumber + StreetName + CondoUnit,
 * bypassing the address-point layer and spatial lookup entirely.
 *
 * The county stores unit numbers in the CondoUnit field exactly as recorded
 * (e.g. "3", "1001", "A101"). We try the raw value AND a numeric-stripped
 * version (e.g. "03" → "3") to handle zero-padding differences.
 */
export async function lookupParcelByAddressUnit(
  houseNumber: string,
  streetName: string,
  streetType: string | undefined,
  unit: string,
  opts: GisQueryOptions = {},
): Promise<ParcelHit | null> {
  const hn = houseNumber.replace(/'/g, "''");
  const sn = streetName.replace(/'/g, "''").toUpperCase();
  const unitRaw = unit.replace(/'/g, "''");
  const unitNumeric = String(Number(unit)) !== 'NaN' ? String(Number(unit)) : null;

  // Try: exact unit match, then numeric-normalized unit
  const unitVariants = [unitRaw, ...(unitNumeric && unitNumeric !== unitRaw ? [unitNumeric] : [])];

  for (const u of unitVariants) {
    let where = `UPPER(HouseNumber)='${hn}' AND UPPER(StreetName)='${sn}' AND UPPER(CondoUnit)='${u.toUpperCase()}'`;
    if (streetType) {
      const st = streetType.replace(/'/g, "''").toUpperCase();
      where = `UPPER(HouseNumber)='${hn}' AND UPPER(StreetName)='${sn}' AND UPPER(StreetType)='${st}' AND UPPER(CondoUnit)='${u.toUpperCase()}'`;
    }
    const url = `${PARCEL_URL}?${new URLSearchParams({
      where,
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      f: 'json',
      resultRecordCount: '1',
    })}`;
    try {
      const data = await httpJson<ArcGisResponse<ParcelAttributes>>(url, {
        recorder: opts.recorder,
        fetcherCallId: opts.fetcherCallId ?? null,
        sourceLabel: 'buncombe.parcel.unit',
      });
      const f = data.features?.[0];
      if (f) return { attributes: f.attributes, geometry: f.geometry, centroid: pickCentroid(f.geometry) };
    } catch { /* try next variant */ }
  }
  return null;
}

/**
 * Find all condo/townhome unit parcels at a given street address.
 * Used to detect when a user searched for a condo building without specifying a unit,
 * so we can show them which units exist.
 *
 * Returns only parcels whose PIN contains "C" (condo unit indicator).
 */
export async function findCondoUnitsAtAddress(
  houseNumber: string,
  streetName: string,
  streetType: string | undefined,
  opts: GisQueryOptions = {},
): Promise<Array<{ pin: string; condoUnit: string; owner: string }>> {
  const hn = houseNumber.replace(/'/g, "''");
  const sn = streetName.replace(/'/g, "''").toUpperCase();
  let where = `UPPER(HouseNumber)='${hn}' AND UPPER(StreetName)='${sn}' AND PIN LIKE '%C%'`;
  if (streetType) {
    const st = streetType.replace(/'/g, "''").toUpperCase();
    where = `UPPER(HouseNumber)='${hn}' AND UPPER(StreetName)='${sn}' AND UPPER(StreetType)='${st}' AND PIN LIKE '%C%'`;
  }
  const url = `${PARCEL_URL}?${new URLSearchParams({
    where,
    outFields: 'PIN,CondoUnit,Owner',
    returnGeometry: 'false',
    f: 'json',
    resultRecordCount: '100',
  })}`;
  try {
    const data = await httpJson<ArcGisResponse<ParcelAttributes>>(url, {
      recorder: opts.recorder,
      fetcherCallId: opts.fetcherCallId ?? null,
      sourceLabel: 'buncombe.parcel.condo-units',
    });
    return (data.features ?? [])
      .map((f) => ({
        pin: String(f.attributes.PIN ?? ''),
        condoUnit: String(f.attributes.CondoUnit ?? ''),
        owner: String(f.attributes.Owner ?? f.attributes.OwnerName ?? ''),
      }))
      .filter((u) => u.condoUnit); // skip common-area records with no CondoUnit
  } catch {
    return [];
  }
}

function pickCentroid(geom: unknown): { lon: number; lat: number } | undefined {
  if (!geom || typeof geom !== 'object') return undefined;
  const g = geom as Record<string, unknown>;
  if (typeof g.x === 'number' && typeof g.y === 'number') {
    return { lon: g.x, lat: g.y };
  }
  // Polygon: take centroid of first ring (rough mean)
  const rings = g.rings as number[][][] | undefined;
  if (rings && rings[0]?.length) {
    let sx = 0, sy = 0;
    for (const [x, y] of rings[0]) { sx += x; sy += y; }
    const n = rings[0].length;
    return { lon: sx / n, lat: sy / n };
  }
  return undefined;
}
