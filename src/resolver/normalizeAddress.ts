/**
 * Address normalization for GIS lookup.
 *
 * The Buncombe County address points layer stores street types as
 * USPS abbreviations ("RD", "LN", "ST"), so we MUST emit the
 * abbreviation, not the long form. The previous implementation
 * had two bugs:
 *
 *   1. It checked the trailing token against STREET_TYPE_MAP without
 *      stripping punctuation first, so "Rd." or "Ln," never matched.
 *   2. When it did match, it stored the long form ("Road"/"Lane")
 *      instead of the abbreviation, then queried GIS with that long
 *      form and got zero results.
 *
 * Both are fixed here. The function returns BOTH the canonical
 * abbreviation and a "queryForms" list so callers can try variations.
 */

export interface NormalizedAddress {
  /** Original input, untouched */
  original: string;
  /** All-uppercase, single-spaced, punctuation-stripped */
  cleaned: string;
  houseNumber?: string;
  /** Pre-directional like N, S, E, W, NE, SW */
  preDirection?: string;
  /** Street name proper (no number, no type, no direction) */
  streetName?: string;
  /** Canonical USPS street-type abbreviation (e.g. "RD", "LN") */
  streetType?: string;
  /** Post-directional like N, S, E, W */
  postDirection?: string;
  unit?: string;
  city?: string;
  state?: string;
  zip?: string;
  /**
   * Multiple equivalent forms to try against GIS in order of specificity.
   * Always include the cleaned form and a number+street form.
   */
  queryForms: string[];
}

// USPS street-type abbreviations. Map common spellings/abbrevs to canonical USPS abbrev.
// Source: USPS Publication 28, Appendix C1.
const STREET_TYPE_MAP: Record<string, string> = {
  ALLEY: 'ALY', ALY: 'ALY',
  AVENUE: 'AVE', AVE: 'AVE', AV: 'AVE',
  BOULEVARD: 'BLVD', BLVD: 'BLVD', BLV: 'BLVD',
  CIRCLE: 'CIR', CIR: 'CIR', CIRC: 'CIR',
  COURT: 'CT', CT: 'CT',
  COVE: 'CV', CV: 'CV',
  CREEK: 'CRK', CRK: 'CRK',
  CROSSING: 'XING', XING: 'XING',
  DRIVE: 'DR', DR: 'DR', DRV: 'DR',
  EXTENSION: 'EXT', EXT: 'EXT',
  FREEWAY: 'FWY', FWY: 'FWY',
  GROVE: 'GRV', GRV: 'GRV',
  HEIGHTS: 'HTS', HTS: 'HTS',
  HIGHWAY: 'HWY', HWY: 'HWY',
  HOLLOW: 'HOLW', HOLW: 'HOLW',
  JUNCTION: 'JCT', JCT: 'JCT',
  LANE: 'LN', LN: 'LN',
  LOOP: 'LOOP',
  MANOR: 'MNR', MNR: 'MNR',
  MOUNTAIN: 'MTN', MTN: 'MTN', MT: 'MTN',
  PARKWAY: 'PKWY', PKWY: 'PKWY', PKY: 'PKWY',
  PATH: 'PATH',
  PIKE: 'PIKE',
  PLACE: 'PL', PL: 'PL',
  PLAZA: 'PLZ', PLZ: 'PLZ',
  POINT: 'PT', PT: 'PT',
  RIDGE: 'RDG', RDG: 'RDG',
  ROAD: 'RD', RD: 'RD',
  ROUTE: 'RTE', RTE: 'RTE', RT: 'RTE',
  ROW: 'ROW',
  RUN: 'RUN',
  SQUARE: 'SQ', SQ: 'SQ',
  STREET: 'ST', ST: 'ST', STR: 'ST',
  TERRACE: 'TER', TER: 'TER', TERR: 'TER',
  TRACE: 'TRCE', TRCE: 'TRCE',
  TRAIL: 'TRL', TRL: 'TRL', TR: 'TRL',
  TURNPIKE: 'TPKE', TPKE: 'TPKE',
  VALLEY: 'VLY', VLY: 'VLY',
  VIEW: 'VW', VW: 'VW',
  VILLAGE: 'VLG', VLG: 'VLG',
  WALK: 'WALK',
  WAY: 'WAY',
  WOODS: 'WDS', WDS: 'WDS',
};

const DIRECTION_MAP: Record<string, string> = {
  NORTH: 'N', N: 'N',
  SOUTH: 'S', S: 'S',
  EAST: 'E', E: 'E',
  WEST: 'W', W: 'W',
  NORTHEAST: 'NE', NE: 'NE',
  NORTHWEST: 'NW', NW: 'NW',
  SOUTHEAST: 'SE', SE: 'SE',
  SOUTHWEST: 'SW', SW: 'SW',
};

const UNIT_MARKERS = new Set(['APT', 'UNIT', 'STE', 'SUITE', '#', 'BLDG', 'LOT']);

// US state and territory codes — used to detect the trailing "STATE ZIP" of an
// address so we don't mistake them for street tokens. We do NOT use a generic
// "any two letters at the end is a state" heuristic, because that breaks valid
// street types like "RD", "LN", "ST".
const STATE_CODES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','PR','VI','GU','AS','MP',
]);

/** Strip punctuation, collapse whitespace, uppercase. */
export function cleanAddress(input: string): string {
  return input
    .toUpperCase()
    // Remove all punctuation EXCEPT internal hyphens and # for unit markers
    .replace(/[.,'"\\/():;!?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Token-level cleaner: strip trailing/leading punctuation from a single token. */
function cleanToken(t: string): string {
  return t.replace(/^[^\w#]+|[^\w#]+$/g, '');
}

export function normalizeAddress(raw: string): NormalizedAddress {
  const cleaned = cleanAddress(raw);
  const tokens = cleaned.split(' ').map(cleanToken).filter(Boolean);

  const result: NormalizedAddress = { original: raw, cleaned, queryForms: [] };
  if (tokens.length === 0) return result;

  // 1. House number is the first token if it's all digits (or digits with letter suffix like 123A)
  let i = 0;
  if (/^\d+[A-Z]?$/.test(tokens[i])) {
    result.houseNumber = tokens[i];
    i++;
  }

  // 2. Optional pre-direction — but only consume if there's still content after it
  if (tokens[i] && DIRECTION_MAP[tokens[i]] && tokens.length - i >= 2) {
    result.preDirection = DIRECTION_MAP[tokens[i]];
    i++;
  }

  // 3. Pre-scan from the END to identify zip / state / unit tokens so we don't
  //    mistake them for street parts. We trim those off before scanning for the
  //    street type.
  let endIdx = tokens.length; // exclusive
  let zipFound: string | undefined;
  let stateFound: string | undefined;
  // Trailing zip
  if (endIdx > 0 && /^\d{5}(-\d{4})?$/.test(tokens[endIdx - 1])) {
    zipFound = tokens[endIdx - 1];
    endIdx--;
  }
  // Trailing state code (only from a known set so we don't eat "RD"/"LN"/etc.)
  if (endIdx > 0 && STATE_CODES.has(tokens[endIdx - 1])) {
    stateFound = tokens[endIdx - 1];
    endIdx--;
  }
  // Strip a unit segment (e.g. "APT 4B") if present anywhere after the street
  let unitFound: string | undefined;
  for (let j = i; j < endIdx; j++) {
    if (UNIT_MARKERS.has(tokens[j]) && tokens[j + 1]) {
      unitFound = tokens[j + 1];
      // Drop the unit marker and value entirely from the middle scan
      endIdx = j;
      break;
    }
  }

  // The "middle" is between the post-house/direction prefix and any trailing
  // city/state/zip/unit we just trimmed. It still contains the street name +
  // type + optional post-direction, possibly followed by a city name.
  const middle = tokens.slice(i, endIdx);

  // Scan middle from END backwards for a street type. The type can appear at
  // the last position OR second-to-last (with a trailing post-direction).
  // This handles addresses like "546 OLD HAW CREEK RD ASHEVILLE NC" where
  // city/state may have leaked into middle: we still find RD before ASHEVILLE.
  let typeIdx = -1;
  let postDirIdx = -1;
  for (let k = middle.length - 1; k >= 0; k--) {
    if (STREET_TYPE_MAP[middle[k]]) {
      typeIdx = k;
      result.streetType = STREET_TYPE_MAP[middle[k]];
      // Direction immediately after the type is a post-direction
      if (k + 1 < middle.length && DIRECTION_MAP[middle[k + 1]]) {
        postDirIdx = k + 1;
        result.postDirection = DIRECTION_MAP[middle[k + 1]];
      }
      break;
    }
  }

  if (typeIdx >= 0) {
    let nameTokens = middle.slice(0, typeIdx);
    // Edge case: "100 South Street" — preDirection ate SOUTH, leaving nothing
    // for the street name. Back off and treat preDirection as part of the name.
    if (nameTokens.length === 0 && result.preDirection) {
      nameTokens = [
        Object.keys(DIRECTION_MAP).find(
          (k) => DIRECTION_MAP[k] === result.preDirection && k.length > 2,
        ) ?? result.preDirection,
      ];
      result.preDirection = undefined;
    }
    result.streetName = nameTokens.join(' ').trim() || undefined;
  } else {
    // No type found — whole middle is the street name (best effort)
    result.streetName = middle.join(' ').trim() || undefined;
  }

  // 4. Apply pre-scanned trailing fields.
  if (zipFound) result.zip = zipFound;
  if (stateFound) result.state = stateFound;
  if (unitFound) result.unit = unitFound;
  // Any tokens between (typeIdx + postDir) and the trailing trim are the city.
  if (typeIdx >= 0) {
    const cityStart = postDirIdx >= 0 ? postDirIdx + 1 : typeIdx + 1;
    const city = middle.slice(cityStart).join(' ').trim();
    if (city) result.city = city;
  }

  // 5. Build query forms in order of specificity.
  //    The GIS layer indexes "FullCivicAddress" like "123 SAMPLE RD".
  const parts: string[] = [];
  if (result.houseNumber) parts.push(result.houseNumber);
  if (result.preDirection) parts.push(result.preDirection);
  if (result.streetName) parts.push(result.streetName);
  if (result.streetType) parts.push(result.streetType);
  if (result.postDirection) parts.push(result.postDirection);
  const canonical = parts.join(' ').trim();

  result.queryForms = uniq([
    canonical,
    // Without unit/state/zip extras
    [result.houseNumber, result.streetName, result.streetType].filter(Boolean).join(' ').trim(),
    // Just street name + type (in case house number is wrong)
    [result.streetName, result.streetType].filter(Boolean).join(' ').trim(),
    // Just the cleaned input as a last resort
    cleaned,
  ].filter(Boolean));

  return result;
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr));
}
