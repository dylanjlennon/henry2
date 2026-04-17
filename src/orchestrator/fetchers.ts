/**
 * Registry of all available fetchers. Import from here rather than from
 * individual fetcher modules, so we have one spot to enable/disable things.
 */

import type { Fetcher } from '../types.js';
import { parcelJsonFetcher } from '../fetchers/parcelJson.js';
import { femaFloodFetcher } from '../fetchers/femaFlood.js';
import { septicFetcher } from '../fetchers/septic.js';
import { propertyCardFetcher } from '../fetchers/propertyCard.js';
import { taxBillFetcher } from '../fetchers/taxBill.js';
import { gisMapFetcher } from '../fetchers/gisMap.js';
import { deedFetcher } from '../fetchers/deed.js';
import { platFetcher } from '../fetchers/plat.js';
import { firmetteFetcher } from '../fetchers/firmette.js';
import { buncombePermitsFetcher } from '../fetchers/buncombePermits.js';
import { simplicityPropertyFetcher } from '../fetchers/simplicityProperty.js';
import { ashevillePermitsFetcher } from '../fetchers/ashevillePermits.js';
import { sewerMapFetcher } from '../fetchers/sewerMap.js';
import { slopeFetcher } from '../fetchers/slope.js';
import { adjacentParcelsFetcher } from '../fetchers/adjacentParcels.js';
import { jurisdictionFetcher } from '../fetchers/jurisdiction.js';
import { historicDistrictFetcher } from '../fetchers/historicDistrict.js';
import { landslideHazardFetcher } from '../fetchers/landslideHazard.js';
import { strEligibilityFetcher } from '../fetchers/strEligibility.js';
import { nationalRiskIndexFetcher } from '../fetchers/nationalRiskIndex.js';
import { soilSepticFetcher } from '../fetchers/soilSeptic.js';

export const ALL_FETCHERS: Fetcher[] = [
  // REST fetchers — fast, always run
  parcelJsonFetcher,
  femaFloodFetcher,
  septicFetcher,
  // REST fetchers — property context
  jurisdictionFetcher,
  adjacentParcelsFetcher,
  historicDistrictFetcher,
  slopeFetcher,
  // REST fetchers — hazard & risk
  landslideHazardFetcher,
  nationalRiskIndexFetcher,
  soilSepticFetcher,
  // REST fetchers — regulatory
  strEligibilityFetcher,
  // Browser fetchers — property record & valuation
  propertyCardFetcher,
  taxBillFetcher,
  // Browser fetchers — title documents
  deedFetcher,
  platFetcher,
  // Browser fetchers — maps
  gisMapFetcher,
  firmetteFetcher,
  sewerMapFetcher,
  // Browser fetchers — permits
  buncombePermitsFetcher,
  simplicityPropertyFetcher,
  ashevillePermitsFetcher,
];

/** Get a fetcher by id, or throw. */
export function getFetcher(id: string): Fetcher {
  const f = ALL_FETCHERS.find((x) => x.id === id);
  if (!f) throw new Error(`Unknown fetcher: ${id}`);
  return f;
}
