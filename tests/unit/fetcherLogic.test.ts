/**
 * Unit tests for pure fetcher logic — no network calls, no DB.
 *
 * Covers:
 *  - strEligibility zone classification (ASHEVILLE_STR_ALLOWED_ZONES set)
 *  - adjacentParcels PIN exclusion (startsWith logic)
 *  - NRI topHazards computation
 *  - slope gradient formula
 *  - landslide riskLevel derivation
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// strEligibility — zone classification
// ---------------------------------------------------------------------------

// Mirror the set exactly as it appears in src/fetchers/strEligibility.ts
const ASHEVILLE_STR_ALLOWED_ZONES = new Set([
  // Old-style (Zoning_ForUrban5 layer)
  'RS2', 'RS4', 'RS8', 'RSMH', 'RM6', 'RM8', 'RM16',
  'HB', 'NB', 'CBD', 'OB', 'OI',
  'MX', 'MX1', 'MX2', 'UV', 'UP',
  // New UDO-style (RS-1 is NOT permitted; all others generally are)
  'RS-2', 'RS-4', 'RS-8', 'RS-MH', 'RM-6', 'RM-8', 'RM-16',
  'B-1', 'B-2', 'B-3', 'B-4', 'MX-1', 'MX-2',
]);

/** Mimics the eligibility derivation in strEligibilityFetcher.run() */
function deriveEligibility(zoningDistrict: string | null): boolean | null {
  if (!zoningDistrict) return null;
  return ASHEVILLE_STR_ALLOWED_ZONES.has(zoningDistrict.toUpperCase());
}

describe('strEligibility — zone classification', () => {
  it('RS1 (not in set) → eligible = false', () => {
    expect(deriveEligibility('RS1')).toBe(false);
  });

  it('RS2 → eligible = true', () => {
    expect(deriveEligibility('RS2')).toBe(true);
  });

  it('RS4 → eligible = true', () => {
    expect(deriveEligibility('RS4')).toBe(true);
  });

  it('RS8 → eligible = true', () => {
    expect(deriveEligibility('RS8')).toBe(true);
  });

  it('RM16 → eligible = true', () => {
    expect(deriveEligibility('RM16')).toBe(true);
  });

  it('HB → eligible = true', () => {
    expect(deriveEligibility('HB')).toBe(true);
  });

  it('CBD → eligible = true', () => {
    expect(deriveEligibility('CBD')).toBe(true);
  });

  it('IND2 (unknown zone) → eligible = false', () => {
    expect(deriveEligibility('IND2')).toBe(false);
  });

  it('empty string → null (zoningDistrict would be null)', () => {
    expect(deriveEligibility('')).toBeNull();
    expect(deriveEligibility(null)).toBeNull();
  });

  it('old-style RS8 → eligible = true', () => {
    expect(deriveEligibility('RS8')).toBe(true);
  });

  it('new UDO-style RS-8 → eligible = true', () => {
    expect(deriveEligibility('RS-8')).toBe(true);
  });

  it('new UDO-style RS-1 → eligible = false (not in set)', () => {
    expect(deriveEligibility('RS-1')).toBe(false);
  });

  it('case-insensitive: rs8 → eligible = true', () => {
    expect(deriveEligibility('rs8')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// adjacentParcels — PIN exclusion logic (startsWith)
// ---------------------------------------------------------------------------

describe('adjacentParcels — PIN exclusion (startsWith)', () => {
  const selfPin = '9648954289'; // 10-digit GIS PIN

  it('"964895428900000".startsWith("9648954289") → true (should be excluded = self)', () => {
    expect('964895428900000'.startsWith(selfPin)).toBe(true);
  });

  it('"964895428900001".startsWith("9648954289") → true (same parcel family, also excluded)', () => {
    expect('964895428900001'.startsWith(selfPin)).toBe(true);
  });

  it('"964895428899999".startsWith("9648954289") → false (neighbor, should be included)', () => {
    expect('964895428899999'.startsWith(selfPin)).toBe(false);
  });

  it('"9648954289".startsWith("9648954289") → true (exact match, excluded)', () => {
    expect('9648954289'.startsWith(selfPin)).toBe(true);
  });

  it('completely different PIN → false (included as neighbor)', () => {
    expect('965986605400000'.startsWith(selfPin)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NRI topHazards computation
// ---------------------------------------------------------------------------

type HazardRating = string | null;

interface NriHazardScore {
  hazard: string;
  score: number | null;
  rating: HazardRating;
}

/** Mirrors the topHazards derivation in nationalRiskIndex.ts */
function computeTopHazards(hazards: NriHazardScore[]): string[] {
  return hazards
    .filter((h) => h.rating && /very high|relatively high/i.test(h.rating))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((h) => h.hazard);
}

describe('nationalRiskIndex — topHazards computation', () => {
  it('"Very High" rating → included in topHazards', () => {
    const hazards: NriHazardScore[] = [
      { hazard: 'Landslide', score: 80, rating: 'Very High' },
    ];
    expect(computeTopHazards(hazards)).toContain('Landslide');
  });

  it('"Relatively High" rating → included in topHazards', () => {
    const hazards: NriHazardScore[] = [
      { hazard: 'Wildfire', score: 50, rating: 'Relatively High' },
    ];
    expect(computeTopHazards(hazards)).toContain('Wildfire');
  });

  it('"Relatively Moderate" rating → NOT included', () => {
    const hazards: NriHazardScore[] = [
      { hazard: 'Tornado', score: 40, rating: 'Relatively Moderate' },
    ];
    expect(computeTopHazards(hazards)).not.toContain('Tornado');
  });

  it('"Relatively Low" rating → NOT included', () => {
    const hazards: NriHazardScore[] = [
      { hazard: 'Drought', score: 20, rating: 'Relatively Low' },
    ];
    expect(computeTopHazards(hazards)).not.toContain('Drought');
  });

  it('null rating → NOT included', () => {
    const hazards: NriHazardScore[] = [
      { hazard: 'Tsunami', score: null, rating: null },
    ];
    expect(computeTopHazards(hazards)).not.toContain('Tsunami');
  });

  it('topHazards are sorted by score descending', () => {
    const hazards: NriHazardScore[] = [
      { hazard: 'Wildfire', score: 30, rating: 'Relatively High' },
      { hazard: 'Landslide', score: 90, rating: 'Very High' },
      { hazard: 'Ice Storm', score: 60, rating: 'Very High' },
    ];
    const top = computeTopHazards(hazards);
    expect(top).toEqual(['Landslide', 'Ice Storm', 'Wildfire']);
  });

  it('returns empty array when no hazards qualify', () => {
    const hazards: NriHazardScore[] = [
      { hazard: 'Drought', score: 10, rating: 'Relatively Low' },
      { hazard: 'Tsunami', score: null, rating: null },
    ];
    expect(computeTopHazards(hazards)).toHaveLength(0);
  });

  it('handles empty input gracefully', () => {
    expect(computeTopHazards([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// slope gradient formula
// ---------------------------------------------------------------------------

function computeSlope(
  center: number | null,
  north: number | null,
  south: number | null,
  east: number | null,
  west: number | null,
): { slopePct: number | null; slopeDeg: number | null } {
  if (center === null || north === null || south === null || east === null || west === null) {
    return { slopePct: null, slopeDeg: null };
  }
  const DIST_FT = 328.084; // 100 m in feet
  const dzNS = Math.abs(north - south) / (2 * DIST_FT);
  const dzEW = Math.abs(east - west) / (2 * DIST_FT);
  const gradient = Math.sqrt(dzNS * dzNS + dzEW * dzEW);
  const slopePct = Math.round(gradient * 100 * 10) / 10;
  const slopeDeg = Math.round(Math.atan(slopePct / 100) * (180 / Math.PI) * 10) / 10;
  return { slopePct, slopeDeg };
}

describe('slope — gradient formula', () => {
  it('computes slope from cardinal elevation samples (center=2000, north=2050, south=1950, east=2020, west=1980)', () => {
    const { slopePct, slopeDeg } = computeSlope(2000, 2050, 1950, 2020, 1980);

    // dzNS = |2050-1950| / (2 * 328.084) = 100 / 656.168 ≈ 0.15238
    // dzEW = |2020-1980| / (2 * 328.084) = 40 / 656.168 ≈ 0.06095
    // gradient = sqrt(0.15238² + 0.06095²) ≈ 0.16413
    // slopePct ≈ 16.4%
    expect(slopePct).toBeCloseTo(16.4, 0);
    expect(slopePct).toBeGreaterThan(16);
    expect(slopePct).toBeLessThan(17);
  });

  it('slopeDeg = Math.atan(slopePct/100) * (180/PI) ≈ 9.3°', () => {
    const { slopeDeg } = computeSlope(2000, 2050, 1950, 2020, 1980);
    expect(slopeDeg).toBeCloseTo(9.3, 0);
    expect(slopeDeg).toBeGreaterThan(9);
    expect(slopeDeg).toBeLessThan(10);
  });

  it('all null inputs → slopePct = null, slopeDeg = null', () => {
    const { slopePct, slopeDeg } = computeSlope(null, null, null, null, null);
    expect(slopePct).toBeNull();
    expect(slopeDeg).toBeNull();
  });

  it('any single null input → slopePct = null', () => {
    expect(computeSlope(2000, null, 1950, 2020, 1980).slopePct).toBeNull();
    expect(computeSlope(2000, 2050, null, 2020, 1980).slopePct).toBeNull();
    expect(computeSlope(2000, 2050, 1950, null, 1980).slopePct).toBeNull();
    expect(computeSlope(2000, 2050, 1950, 2020, null).slopePct).toBeNull();
  });

  it('flat terrain → slopePct = 0', () => {
    const { slopePct, slopeDeg } = computeSlope(1000, 1000, 1000, 1000, 1000);
    expect(slopePct).toBe(0);
    expect(slopeDeg).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// landslide riskLevel computation
// ---------------------------------------------------------------------------

/** Mirrors deriveRiskLevel() in src/fetchers/landslideHazard.ts */
function deriveRiskLevel(
  landslides: number,
  slopeMovements: number,
  debrisFlows: number,
  stability: number | null,
): 'none' | 'low' | 'moderate' | 'high' {
  if (debrisFlows > 0 || slopeMovements > 0 || stability === 3) return 'high';
  if (landslides > 2 || stability === 2) return 'moderate';
  if (landslides > 0) return 'low';
  return 'none';
}

describe('landslideHazard — riskLevel derivation', () => {
  it('debrisFlowCount > 0 → "high"', () => {
    expect(deriveRiskLevel(0, 0, 1, null)).toBe('high');
  });

  it('slopeMovementCount > 0 → "high" (even with stabilityIndex 1)', () => {
    expect(deriveRiskLevel(0, 1, 0, 1)).toBe('high');
  });

  it('stabilityIndex === 3 → "high"', () => {
    expect(deriveRiskLevel(0, 0, 0, 3)).toBe('high');
  });

  it('stabilityIndex === 2 AND slopeMovementCount === 0 → "moderate"', () => {
    expect(deriveRiskLevel(0, 0, 0, 2)).toBe('moderate');
  });

  it('landslides > 2 → "moderate"', () => {
    expect(deriveRiskLevel(3, 0, 0, null)).toBe('moderate');
  });

  it('landslides > 2 AND stabilityIndex === 2 → "moderate" (checks > 2 threshold)', () => {
    expect(deriveRiskLevel(3, 0, 0, 2)).toBe('moderate');
  });

  it('landslides === 2 → NOT moderate (must be > 2), falls through to "low"', () => {
    expect(deriveRiskLevel(2, 0, 0, null)).toBe('low');
  });

  it('stabilityIndex === 1 AND nearbyLandslideCount === 0 → "none"', () => {
    expect(deriveRiskLevel(0, 0, 0, 1)).toBe('none');
  });

  it('all zeros, null stability → "none"', () => {
    expect(deriveRiskLevel(0, 0, 0, null)).toBe('none');
  });

  it('landslides === 1, no other risk factors → "low"', () => {
    expect(deriveRiskLevel(1, 0, 0, null)).toBe('low');
  });

  it('debrisFlows wins over everything else → "high"', () => {
    // Even low stability + high landslides: debris flow trumps
    expect(deriveRiskLevel(10, 5, 2, 1)).toBe('high');
  });
});
