/**
 * Coordinate reprojection for Buncombe County raster services.
 *
 * Buncombe's DEM and PERCENTSLOPE ImageServers require EPSG:2264
 * (NC State Plane NAD83, US Survey Feet). StabilityIndexMap requires
 * EPSG:32119 (NC State Plane NAD83, meters). All other endpoints
 * accept EPSG:4326 (WGS84 lon/lat) natively.
 */

import proj4 from 'proj4';

// NC State Plane NAD83 — US Survey Feet (used by DEM, PERCENTSLOPE)
proj4.defs('EPSG:2264', '+proj=lcc +lat_0=33.75 +lon_0=-79 +lat_1=36.1666666666667 +lat_2=34.3333333333333 +x_0=609601.219202438 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs');

// NC State Plane NAD83 — meters (used by StabilityIndexMap)
proj4.defs('EPSG:32119', '+proj=lcc +lat_0=33.75 +lon_0=-79 +lat_1=36.1666666666667 +lat_2=34.3333333333333 +x_0=609601.2192024384 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

export interface ReprojectedPoint {
  /** EPSG:2264 — US Survey Feet (for DEM + PERCENTSLOPE rasters) */
  xFt: number;
  yFt: number;
  /** EPSG:32119 — Meters (for StabilityIndexMap raster) */
  xM: number;
  yM: number;
}

/** Reproject a WGS84 lon/lat to both NC State Plane projections at once. */
export function reprojectPoint(lon: number, lat: number): ReprojectedPoint {
  const [xFt, yFt] = proj4('EPSG:4326', 'EPSG:2264', [lon, lat]);
  const [xM, yM] = proj4('EPSG:4326', 'EPSG:32119', [lon, lat]);
  return { xFt, yFt, xM, yM };
}
