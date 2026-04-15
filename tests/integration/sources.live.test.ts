/**
 * Live URL validation — hits every Buncombe-county canonical URL we depend on
 * and verifies it responds. Run with `npm run test:integration`.
 *
 * Failures here mean the county has changed something and the URL builders or
 * fetchers need updating. These tests intentionally hit real services so we
 * catch breakage early rather than at the end-user.
 */

import { describe, it, expect } from 'vitest';
import {
  SOURCES,
  arcgisQueryUrl,
  taxBillUrl,
  gisMapViewerUrl,
  deedBookPageUrl,
  platBookPageUrl,
  deedRootUrl,
  femaFirmetteUrl,
  ashevillePermitsUrl,
  accelaPermitsUrl,
  propertyRecordCardUrl,
} from '../../src/sources/buncombe.ts';
import { httpFetch, httpJson } from '../../src/lib/http.ts';

// Real values for 546 Old Haw Creek Rd, verified by the resolver against the
// live API earlier. These are the "golden" inputs for our integration tests.
const REAL_PIN = '9659-86-6054-00000';
const REAL_GIS_PIN = '965986605400000';
const REAL_DEED = { book: '6541', page: '0364' };
const REAL_PLAT = { book: '0254', page: '0075' };
const REAL_CENTROID = { lon: -82.50424695420467, lat: 35.61199078989121 };

interface ArcGisLayerInfo {
  id: number;
  name: string;
  type: string;
  fields?: Array<{ name: string; type: string }>;
  error?: { code: number; message: string };
}

describe('ArcGIS layer metadata — confirms each layer exists and has expected fields', () => {
  it('parcel layer reachable and has PIN field', async () => {
    const info = await httpJson<ArcGisLayerInfo>(`${SOURCES.parcelLayer}?f=json`);
    expect(info.error, JSON.stringify(info.error)).toBeUndefined();
    expect(info.name).toBeTruthy();
    const fieldNames = info.fields?.map((f) => f.name) ?? [];
    expect(fieldNames.some((n) => /^PIN/i.test(n))).toBe(true);
  }, 30_000);

  it('address-points layer reachable and has FullCivicAddress + StreetType', async () => {
    const info = await httpJson<ArcGisLayerInfo>(`${SOURCES.addressLayer}?f=json`);
    expect(info.error).toBeUndefined();
    const fieldNames = info.fields?.map((f) => f.name) ?? [];
    expect(fieldNames).toContain('FullCivicAddress');
    expect(fieldNames).toContain('StreetType');
    expect(fieldNames).toContain('HouseNumber');
  }, 30_000);

  it('septic layer reachable', async () => {
    const info = await httpJson<ArcGisLayerInfo>(`${SOURCES.septicLayer}?f=json`);
    expect(info.error).toBeUndefined();
    expect(info.name).toBeTruthy();
  }, 30_000);

  it('FEMA NFHL flood-zones layer reachable', async () => {
    const info = await httpJson<ArcGisLayerInfo>(`${SOURCES.femaNflhFloodZones}?f=json`);
    expect(info.error).toBeUndefined();
    expect(info.name).toBeTruthy();
  }, 30_000);

  it('FEMA NFHL FIRM-panels layer reachable', async () => {
    const info = await httpJson<ArcGisLayerInfo>(`${SOURCES.femaNflhFirmPanels}?f=json`);
    expect(info.error).toBeUndefined();
    expect(info.name).toBeTruthy();
  }, 30_000);
});

describe('ArcGIS queries — confirms query URLs return real data for our golden property', () => {
  it('parcel layer returns the known property by PIN', async () => {
    const url = arcgisQueryUrl(SOURCES.parcelLayer, {
      where: `PIN='${REAL_GIS_PIN}'`,
      outFields: 'PIN,DeedBook,DeedPage,PlatBook,PlatPage',
      returnGeometry: 'false',
    });
    const res = await httpJson<{ features: Array<{ attributes: Record<string, unknown> }> }>(url);
    expect(res.features.length).toBeGreaterThan(0);
    const a = res.features[0].attributes;
    expect(String(a.DeedBook)).toBe(REAL_DEED.book);
    expect(String(a.DeedPage)).toBe(REAL_DEED.page);
    expect(String(a.PlatBook)).toBe(REAL_PLAT.book);
    expect(String(a.PlatPage)).toBe(REAL_PLAT.page);
  }, 30_000);

  it('address layer finds the known property by FullCivicAddress', async () => {
    const url = arcgisQueryUrl(SOURCES.addressLayer, {
      where: `UPPER(FullCivicAddress) LIKE '546 OLD HAW CREEK%'`,
      outFields: 'FullCivicAddress,HouseNumber,StreetName,StreetType',
      returnGeometry: 'false',
    });
    const res = await httpJson<{ features: Array<{ attributes: Record<string, unknown> }> }>(url);
    expect(res.features.length).toBeGreaterThan(0);
    const a = res.features[0].attributes;
    expect(a.StreetType).toBe('RD');
    expect(a.StreetName).toBe('OLD HAW CREEK');
  }, 30_000);

  it('FEMA flood-zones spatial query accepts our query shape', async () => {
    const url = arcgisQueryUrl(SOURCES.femaNflhFloodZones, {
      where: '1=1',
      geometry: JSON.stringify({
        x: REAL_CENTROID.lon,
        y: REAL_CENTROID.lat,
        spatialReference: { wkid: 4326 },
      }),
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      // FIRM_PAN lives on the FIRM-panels layer (16), not flood-zones (28).
      outFields: 'FLD_ZONE,FLD_AR_ID,SFHA_TF,STATIC_BFE',
      returnGeometry: 'false',
    });
    const res = await httpJson<{ features: unknown[]; error?: { message: string } }>(url);
    expect(res.error, JSON.stringify(res.error)).toBeUndefined();
    expect(Array.isArray(res.features)).toBe(true);
  }, 30_000);
});

describe('Public web pages — passive HTTP probe (no auth, no session)', () => {
  // These pages are publicly reachable without a cookie session and should
  // return a 2xx for our golden inputs.
  const cases = [
    { name: 'tax bill', url: taxBillUrl(REAL_GIS_PIN) },
    { name: 'GIS map viewer', url: gisMapViewerUrl(REAL_PIN) },
    { name: 'Property Record Card root', url: propertyRecordCardUrl() },
    { name: 'Asheville permits', url: ashevillePermitsUrl(REAL_PIN) },
    { name: 'Accela permits', url: accelaPermitsUrl() },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const res = await httpFetch(c.url, { timeoutMs: 25_000, retries: 1 });
      expect(
        res.status,
        `Expected 2xx from ${c.url}, got ${res.status}`,
      ).toBeLessThan(300);
    }, 30_000);
  }
});

describe('Browser-required pages — host reachability probe (don\'t follow login redirects)', () => {
  // These pages require a browser session (cookies + JS) to reach the actual
  // content. We can't passively GET them, but we CAN verify the host responds
  // — that catches things like DNS changes or service outages.
  const cases = [
    { name: 'Register of Deeds root', url: deedRootUrl() },
    {
      name: 'ROD deed deep-link (will redirect to login w/o session)',
      url: deedBookPageUrl(REAL_DEED.book, REAL_DEED.page),
    },
    {
      name: 'ROD plat deep-link (will redirect to login w/o session)',
      url: platBookPageUrl(REAL_PLAT.book, REAL_PLAT.page),
    },
    {
      name: 'FEMA firmette w/ fake panel (redirects to portal home)',
      url: femaFirmetteUrl('3700123456J'),
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      // redirect: 'manual' means we don't follow — we just verify the host
      // returned ANY response (2xx, 3xx, 4xx all OK; only network failures fail).
      const res = await httpFetch(c.url, {
        timeoutMs: 25_000,
        retries: 1,
        redirect: 'manual',
      });
      expect(res.status, `host unreachable: ${c.url}`).toBeGreaterThan(0);
      expect(res.status).toBeLessThan(600);
    }, 30_000);
  }
});
