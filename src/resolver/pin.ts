/**
 * PIN normalization.
 *
 * Buncombe County stores PINs as 15-digit strings in GIS, but
 * displays them as 4-2-4-5 dashed (e.g. "9648-65-1234-00000").
 * We accept either form and produce both.
 */

export interface NormalizedPin {
  /** 15 digits, no separators — what GIS needs */
  gisPin: string;
  /** 4-2-4-5 dashed form — what humans read */
  displayPin: string;
}

/** True if the input looks like a PIN (after stripping non-digits). */
export function looksLikePin(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 15;
}

export function normalizePin(raw: string): NormalizedPin {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 15) {
    throw new Error(`Invalid PIN: expected 15 digits, got ${digits.length} from "${raw}"`);
  }
  const display = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 10)}-${digits.slice(10, 15)}`;
  return { gisPin: digits, displayPin: display };
}
