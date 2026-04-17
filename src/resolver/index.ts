/**
 * Resolver: turns raw user input into a CanonicalProperty.
 *
 * Strategy:
 *   1. If input looks like a PIN (15 digits after stripping), look it up
 *      directly in the parcel layer.
 *   2. Otherwise, normalize as an address, search the address-points
 *      layer for matches, and re-fetch the parcel record by its PIN
 *      to get geometry + deed/plat refs.
 */

import type { CanonicalProperty, ResolverInput } from '../types.js';
import { looksLikePin, normalizePin } from './pin.js';
import { normalizeAddress } from './normalizeAddress.js';
import {
  lookupParcelByPin,
  lookupParcelByPoint,
  lookupParcelByAddressUnit,
  findCondoUnitsAtAddress,
  searchAddress,
  type ParcelHit,
  type AddressHit,
} from './adapters/buncombe.js';
import { log } from '../lib/log.js';

export type ResolveErrorCode =
  | 'county_not_supported'   // non-Buncombe address
  | 'pin_not_found'          // PIN entered but not in parcel layer
  | 'address_not_found'      // address string returned zero GIS hits
  | 'house_number_not_in_gis'// street exists but this house number has no parcel record
  | 'condo_unit_required'    // address is a condo building; user must specify a unit
  | 'condo_unit_not_found'   // unit specified but CondoUnit doesn't match any parcel
  | 'parcel_link_failed';    // address found but couldn't link to a parcel record

export class ResolveError extends Error {
  constructor(
    message: string,
    readonly code: ResolveErrorCode = 'address_not_found',
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ResolveError';
  }
}

export async function resolveProperty(input: ResolverInput): Promise<CanonicalProperty> {
  if (input.county !== 'buncombe') {
    throw new ResolveError(
      `Henry currently covers Buncombe County, NC only. Other counties are not yet supported.`,
      'county_not_supported',
    );
  }
  const raw = input.raw.trim();
  if (!raw) throw new ResolveError('Input is empty', 'address_not_found');

  if (looksLikePin(raw)) {
    return resolvePin(raw);
  }
  return resolveAddress(raw);
}

async function resolvePin(raw: string): Promise<CanonicalProperty> {
  const { gisPin, displayPin } = normalizePin(raw);
  const hit = await lookupParcelByPin(gisPin);
  if (!hit) {
    throw new ResolveError(
      `PIN ${displayPin} was not found in Buncombe County parcel records. ` +
      `Double-check the PIN — it should be 15 digits (e.g. 9648-65-1234-00000) or a condo PIN (e.g. 9649-40-2414-C1001).`,
      'pin_not_found',
    );
  }
  return parcelToCanonical(hit, gisPin, displayPin, 1.0, 'pin-direct');
}

async function resolveAddress(raw: string): Promise<CanonicalProperty> {
  const normalized = normalizeAddress(raw);
  log.debug('resolve_address', { normalized });

  // PATH A: unit specified → query the parcel layer directly by CondoUnit.
  // This is the correct path for all condo/townhome units and avoids the
  // spatial-lookup problem where the address point may sit inside a neighbor's parcel.
  if (normalized.unit && normalized.houseNumber && normalized.streetName) {
    const unitHit = await lookupParcelByAddressUnit(
      normalized.houseNumber,
      normalized.streetName,
      normalized.streetType,
      normalized.unit,
    );
    if (unitHit) {
      const rawPin = String(unitHit.attributes.PIN ?? '').replace(/[-\s]/g, '').toUpperCase();
      if (looksLikePin(rawPin)) {
        const { displayPin } = normalizePin(rawPin);
        const fallbackAddress = String(unitHit.attributes.Address ?? '').trim() || undefined;
        return parcelToCanonical(unitHit, rawPin, displayPin, 1.0, 'address-exact', fallbackAddress);
      }
    }
    // Unit was specified but didn't match — give a specific error.
    throw new ResolveError(
      `Unit "${normalized.unit}" was not found at ${normalized.houseNumber} ${normalized.streetName}${normalized.streetType ? ' ' + normalized.streetType : ''} in Buncombe County GIS. ` +
      `Check the unit number — it must match the county's recorded CondoUnit exactly.`,
      'condo_unit_not_found',
    );
  }

  // PATH B: no unit — standard address search.
  const hits = await searchAddress(normalized);
  if (hits.length === 0) {
    throw new ResolveError(
      `"${raw}" was not found in the Buncombe County address layer. ` +
      `Try a full street address (e.g. "546 Old Haw Creek Rd") or a 15-digit PIN. ` +
      `Henry covers Buncombe County, NC only.`,
      'address_not_found',
    );
  }

  const best = pickBestHit(hits, normalized.houseNumber);
  if (!best) {
    // Street exists but this house number has no address-point entry.
    // Check whether it's a condo building without a unit specified.
    const condoUnits = normalized.houseNumber && normalized.streetName
      ? await findCondoUnitsAtAddress(normalized.houseNumber, normalized.streetName, normalized.streetType)
      : [];

    if (condoUnits.length > 0) {
      const sample = condoUnits.slice(0, 5).map((u) => u.condoUnit).filter(Boolean);
      const examples = sample.map((u) => `${normalized.houseNumber} ${normalized.streetName}${normalized.streetType ? ' ' + normalized.streetType : ''} unit ${u}`).slice(0, 3);
      throw new ResolveError(
        `${normalized.houseNumber} ${normalized.streetName}${normalized.streetType ? ' ' + normalized.streetType : ''} is a condo/multi-unit building with ${condoUnits.length} unit(s) in the county records. ` +
        `Please specify a unit number. Examples:\n${examples.map((e) => `  • ${e}`).join('\n')}`,
        'condo_unit_required',
      );
    }

    throw new ResolveError(
      `House number ${normalized.houseNumber} on ${normalized.streetName}${normalized.streetType ? ' ' + normalized.streetType : ''} was not found in Buncombe County parcel records. ` +
      `This address may be new, renumbered, or outside county GIS coverage. Try searching by PIN instead.`,
      'house_number_not_in_gis',
    );
  }

  // Link the address-point hit to a parcel record.
  let parcel: ParcelHit | null = null;
  const attachedPin = String(best.attributes.PIN ?? best.attributes.PINNUM ?? '').replace(/[-\s]/g, '').toUpperCase();
  if (attachedPin && looksLikePin(attachedPin)) {
    parcel = await lookupParcelByPin(attachedPin);
  }
  if (!parcel && best.centroid) {
    parcel = await lookupParcelByPoint(best.centroid.lon, best.centroid.lat);
  }
  if (!parcel) {
    throw new ResolveError(
      `Found address "${String(best.attributes.FullCivicAddress ?? best.attributes.ADDRESS ?? raw)}" in the county address layer ` +
      `but could not link it to a parcel record. The county GIS data may have a gap here — try searching by PIN.`,
      'parcel_link_failed',
    );
  }

  const rawPin = String(parcel.attributes.PIN ?? parcel.attributes.PINNUM ?? '').replace(/[-\s]/g, '').toUpperCase();
  if (!looksLikePin(rawPin)) {
    throw new ResolveError(
      `The parcel found at "${raw}" has an unrecognized PIN format: "${rawPin}". ` +
      `This may be a common-area or non-standard parcel record.`,
      'parcel_link_failed',
    );
  }

  // If the parcel we landed on is a base parcel that has condo units, and the
  // user didn't specify a unit, prompt them to pick one.
  const basePin10 = rawPin.slice(0, 10);
  if (!rawPin.includes('C') && normalized.houseNumber && normalized.streetName) {
    const condoUnits = await findCondoUnitsAtAddress(normalized.houseNumber, normalized.streetName, normalized.streetType);
    if (condoUnits.length > 0) {
      const sample = condoUnits.slice(0, 5).map((u) => u.condoUnit).filter(Boolean);
      const examples = sample.map((u) => `${normalized.houseNumber} ${normalized.streetName}${normalized.streetType ? ' ' + normalized.streetType : ''} unit ${u}`).slice(0, 3);
      throw new ResolveError(
        `${normalized.houseNumber} ${normalized.streetName}${normalized.streetType ? ' ' + normalized.streetType : ''} is a condo/multi-unit building with ${condoUnits.length} unit(s) in the county records. ` +
        `Please specify a unit number. Examples:\n${examples.map((e) => `  • ${e}`).join('\n')}`,
        'condo_unit_required',
      );
    }
  }
  void basePin10; // used above

  const { displayPin } = normalizePin(rawPin);
  const confidence = computeConfidence(hits.length, best, normalized);
  const source = confidence >= 0.95 ? 'address-exact' : 'address-fuzzy';
  const fallbackAddress = String(best.attributes.FullCivicAddress ?? best.attributes.ADDRESS ?? '').trim() || undefined;
  return parcelToCanonical(parcel, rawPin, displayPin, confidence, source, fallbackAddress);
}

function pickBestHit(hits: AddressHit[], desiredHouseNumber?: string): AddressHit | null {
  if (!desiredHouseNumber) return hits[0] ?? null;
  const exact = hits.find((h) => String(h.attributes.HouseNumber) === desiredHouseNumber);
  // If we have a desired house number but no exact match, return null so the
  // caller can continue trying other query forms rather than silently using a
  // neighbor's address (e.g. returning 188 when 190 was requested).
  return exact ?? null;
}

function computeConfidence(
  hitCount: number,
  best: AddressHit,
  normalized: { houseNumber?: string },
): number {
  let c = 0.7;
  if (hitCount === 1) c += 0.2;
  if (normalized.houseNumber && String(best.attributes.HouseNumber) === normalized.houseNumber) {
    c += 0.1;
  }
  return Math.min(c, 1);
}

function parcelToCanonical(
  hit: ParcelHit,
  gisPin: string,
  displayPin: string,
  confidence: number,
  source: CanonicalProperty['source'],
  fallbackAddress?: string,
): CanonicalProperty {
  const a = hit.attributes;
  const parcelAddress = (a.PropAddr ?? a.PropertyAddress) as string | undefined;
  return {
    county: 'buncombe',
    pin: displayPin,
    gisPin,
    address: parcelAddress || fallbackAddress,
    ownerName: (a.OwnerName ?? a.OwnerName1) as string | undefined,
    centroid: hit.centroid,
    geometry: hit.geometry,
    deed: a.DeedBook && a.DeedPage ? { book: String(a.DeedBook), page: String(a.DeedPage) } : undefined,
    plat: a.PlatBook && a.PlatPage ? { book: String(a.PlatBook), page: String(a.PlatPage) } : undefined,
    confidence,
    source,
  };
}
