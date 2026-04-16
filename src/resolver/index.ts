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
import { lookupParcelByPin, lookupParcelByPoint, searchAddress, type ParcelHit, type AddressHit } from './adapters/buncombe.js';
import { log } from '../lib/log.js';

export class ResolveError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'ResolveError';
  }
}

export async function resolveProperty(input: ResolverInput): Promise<CanonicalProperty> {
  if (input.county !== 'buncombe') {
    throw new ResolveError(`County '${input.county}' not yet supported`);
  }
  const raw = input.raw.trim();
  if (!raw) throw new ResolveError('Empty input');

  if (looksLikePin(raw)) {
    return resolvePin(raw);
  }
  return resolveAddress(raw);
}

async function resolvePin(raw: string): Promise<CanonicalProperty> {
  const { gisPin, displayPin } = normalizePin(raw);
  const hit = await lookupParcelByPin(gisPin);
  if (!hit) throw new ResolveError(`PIN ${displayPin} not found in Buncombe County parcels`);
  return parcelToCanonical(hit, gisPin, displayPin, 1.0, 'pin-direct');
}

async function resolveAddress(raw: string): Promise<CanonicalProperty> {
  const normalized = normalizeAddress(raw);
  log.debug('resolve_address', { normalized });
  const hits = await searchAddress(normalized);
  if (hits.length === 0) {
    throw new ResolveError(
      `Could not resolve address "${raw}". Tried forms: ${normalized.queryForms.join(' | ')}`,
    );
  }
  // Prefer exact-house-number match if present
  const best = pickBestHit(hits, normalized.houseNumber);

  // The address-points layer doesn't carry a PIN attribute — we have to look
  // up the parcel by either (a) attached PIN if present, or (b) spatial query
  // using the address point's coordinates.
  let parcel: ParcelHit | null = null;
  const attachedPin = String(best.attributes.PIN ?? best.attributes.PINNUM ?? '').replace(/\D/g, '');
  if (attachedPin && attachedPin.length === 15) {
    parcel = await lookupParcelByPin(attachedPin);
  }
  if (!parcel && best.centroid) {
    parcel = await lookupParcelByPoint(best.centroid.lon, best.centroid.lat);
  }
  if (!parcel) {
    throw new ResolveError(
      `Address matched at ${JSON.stringify(best.attributes.FullCivicAddress ?? best.attributes)} ` +
      `but could not link to a parcel record.`,
    );
  }
  const pin = String(parcel.attributes.PIN ?? parcel.attributes.PINNUM ?? '').replace(/\D/g, '');
  if (!pin || pin.length !== 15) {
    throw new ResolveError(`Parcel record has no valid PIN: ${JSON.stringify(parcel.attributes)}`);
  }
  const { displayPin } = normalizePin(pin);
  const confidence = computeConfidence(hits.length, best, normalized);
  const source = confidence >= 0.95 ? 'address-exact' : 'address-fuzzy';
  // Fallback address: if the parcel record has no PropAddr/PropertyAddress, use
  // the FullCivicAddress from the address-point layer hit.
  const fallbackAddress =
    String(best.attributes.FullCivicAddress ?? best.attributes.ADDRESS ?? '').trim() || undefined;
  return parcelToCanonical(parcel, pin, displayPin, confidence, source, fallbackAddress);
}

function pickBestHit(hits: AddressHit[], desiredHouseNumber?: string): AddressHit {
  if (!desiredHouseNumber) return hits[0];
  const exact = hits.find((h) => String(h.attributes.HouseNumber) === desiredHouseNumber);
  return exact ?? hits[0];
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
