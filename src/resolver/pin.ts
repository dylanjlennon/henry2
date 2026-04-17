/**
 * PIN normalization.
 *
 * Buncombe County has two PIN formats:
 *
 *   Standard:  15 digits           e.g. "974160276300000"
 *              displayed as 4-2-4-5 dashes: "9741-60-2763-00000"
 *
 *   Condo unit: 10 digits + "C" + 4 digits  e.g. "9741602763C0004"
 *               displayed as 4-2-4-C####:   "9741-60-2763-C0004"
 *               The base parcel PIN is the first 10 digits + "00000".
 *               CondoUnit number appears after the C (zero-padded to 4 digits).
 *
 * Both forms may arrive with or without dashes/spaces from user input.
 */

export interface NormalizedPin {
  /** GIS query key — 15 digits for standard, "XXXXXXXXXX C XXXX" for condo */
  gisPin: string;
  /** Human-readable dashed form */
  displayPin: string;
  /** True for condo unit PINs (contains "C") */
  isCondo: boolean;
}

// e.g. "9741602763C0004" (after stripping dashes/spaces)
const CONDO_RE = /^\d{10}C\d{4}$/i;
// e.g. "974160276300000"
const STANDARD_RE = /^\d{15}$/;

/** Strip separators and uppercase, leaving only digits and any "C". */
function cleanPin(raw: string): string {
  return raw.replace(/[-\s]/g, '').toUpperCase();
}

/** True if the input looks like either a standard or condo unit PIN. */
export function looksLikePin(raw: string): boolean {
  const c = cleanPin(raw);
  return STANDARD_RE.test(c) || CONDO_RE.test(c);
}

export function normalizePin(raw: string): NormalizedPin {
  const c = cleanPin(raw);

  if (CONDO_RE.test(c)) {
    // e.g. "9741602763C0004" → display "9741-60-2763-C0004"
    const display = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 10)}-${c.slice(10)}`;
    return { gisPin: c, displayPin: display, isCondo: true };
  }

  if (STANDARD_RE.test(c)) {
    const display = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 10)}-${c.slice(10, 15)}`;
    return { gisPin: c, displayPin: display, isCondo: false };
  }

  throw new Error(`Invalid PIN "${raw}": expected 15 digits or 10 digits + C + 4 digits`);
}
