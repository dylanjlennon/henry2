/**
 * Canonical URL catalog for Buncombe County data sources.
 *
 * Every external URL Henry hits lives here, as a typed builder. This is the
 * single source of truth for endpoints — fetchers import these builders
 * rather than hard-coding URLs of their own. Integration tests probe each
 * builder against the live service to catch breakage early.
 *
 * If a county changes a URL, this is the only file that changes.
 */

export const SOURCES = {
  /** Buncombe County GIS REST — Parcels FeatureLayer (canonical PIN, deed/plat refs, geometry) */
  parcelLayer: 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/1',
  /** Buncombe County GIS REST — Address Points FeatureLayer (address → location) */
  addressLayer: 'https://gis.buncombecounty.org/arcgis/rest/services/opendata/FeatureServer/2',
  /** Buncombe County Septic data (separate ArcGIS service) */
  septicLayer:
    'https://services6.arcgis.com/VLA0ImJ33zhtGEaP/arcgis/rest/services/Buncombe%20County%20Septic%20Data/FeatureServer/0',
  /** FEMA NFHL — flood hazard zones (layer 28 = Flood Hazard Zones) */
  femaNflhFloodZones: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28',
  /** FEMA NFHL — FIRM panels (layer 3 = FIRM Panels). Verified via service catalog. */
  femaNflhFirmPanels: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/3',
} as const;

/** Property Record Card (Spatialest) — interactive page; we navigate via Playwright. */
export function propertyRecordCardUrl(): string {
  return 'https://prc-buncombe.spatialest.com/';
}

/**
 * Tax bill / parcel details page (web UI scraped via Playwright).
 * IMPORTANT: this endpoint requires the 15-digit GIS PIN (no dashes).
 * Passing the dashed display PIN returns HTTP 400.
 */
export function taxBillUrl(gisPin: string): string {
  if (!/^\d{15}$/.test(gisPin)) {
    throw new Error(`taxBillUrl requires 15-digit GIS PIN (no dashes), got "${gisPin}"`);
  }
  return `https://tax.buncombenc.gov/Parcel/Details/${gisPin}?Query=${gisPin}`;
}

/** County interactive GIS map viewer (we screenshot it via Playwright). */
export function gisMapViewerUrl(displayPin: string): string {
  return `https://gis.buncombenc.gov/buncomap/Default.aspx?PINN=${encodeURIComponent(displayPin)}`;
}

/**
 * Register of Deeds — deed by book/page (idx=CRP).
 * NOTE: this URL is "protected" — opening it without a session cookie
 * results in an infinite redirect loop with /External/User/Login.aspx.
 * Browser fetcher must first hit the host to seed cookies, then visit this URL.
 */
export function deedBookPageUrl(book: string, page: string): string {
  return `https://registerofdeeds.buncombecounty.org/external/LandRecords/protected/v4/SrchBookPage.aspx?bAutoSearch=true&bk=${encodeURIComponent(book)}&pg=${encodeURIComponent(page)}&idx=CRP`;
}

/** Register of Deeds — plat by book/page (idx=PLAT). Same auth quirk as deeds. */
export function platBookPageUrl(book: string, page: string): string {
  return `https://registerofdeeds.buncombecounty.org/external/LandRecords/protected/v4/SrchBookPage.aspx?bAutoSearch=true&bk=${encodeURIComponent(book)}&pg=${encodeURIComponent(page)}&idx=PLAT`;
}

/** Register of Deeds — public root, used to seed session cookies before deep links. */
export function deedRootUrl(): string {
  return 'https://registerofdeeds.buncombecounty.org/';
}

/** FEMA MSC FIRMette generator (PDF download for a given FIRM panel). */
export function femaFirmetteUrl(firmPanel: string): string {
  return `https://msc.fema.gov/portal/downloadFirmette?efsc=${encodeURIComponent(firmPanel)}&type=PDF`;
}

/** City of Asheville permits search (by PIN). */
export function ashevillePermitsUrl(displayPin: string): string {
  return `https://simplicity.ashevillenc.gov/permits/search?search=${encodeURIComponent(displayPin)}`;
}

/** Accela permits portal (county-wide; not parameterized — search performed in-page). */
export function accelaPermitsUrl(): string {
  return 'https://aca-prod.accela.com/BUNCOMBECONC/Cap/CapHome.aspx?module=Building&TabName=Building&TabList=Home%7C0%7CBuilding%7C1%7CEnvironHealth%7C2%7CPlanning%7C3%7CTax%7C4%7CAirQuality%7C5%7CFire%7C6%7CEnvHealth%7C7%7CCurrentTabIndex%7C1';
}

/**
 * Build a generic ArcGIS query URL from a layer base + params. Used by the
 * REST adapters to keep URL construction consistent and inspectable.
 */
export function arcgisQueryUrl(
  layerBase: string,
  params: Record<string, string>,
): string {
  const qs = new URLSearchParams({ f: 'json', ...params });
  return `${layerBase}/query?${qs.toString()}`;
}
