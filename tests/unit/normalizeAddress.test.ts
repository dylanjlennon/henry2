import { describe, it, expect } from 'vitest';
import { normalizeAddress, cleanAddress } from '../../src/resolver/normalizeAddress.ts';

describe('cleanAddress', () => {
  it('strips punctuation and uppercases', () => {
    expect(cleanAddress('123 Main St., Asheville, NC')).toBe('123 MAIN ST ASHEVILLE NC');
  });
  it('collapses multiple spaces', () => {
    expect(cleanAddress('  42   Elm   St  ')).toBe('42 ELM ST');
  });
});

describe('normalizeAddress — bug fixes', () => {
  it('strips trailing punctuation before matching street type (regression)', () => {
    const r = normalizeAddress('546 Old Haw Creek Rd.');
    expect(r.streetType).toBe('RD');
    expect(r.houseNumber).toBe('546');
    expect(r.streetName).toBe('OLD HAW CREEK');
  });

  it('emits USPS abbreviation, not the full word (regression)', () => {
    const r = normalizeAddress('100 Sample Lane');
    expect(r.streetType).toBe('LN'); // NOT "LANE"
    expect(r.queryForms[0]).toContain('LN');
    expect(r.queryForms[0]).not.toContain('LANE');
  });

  it('handles already-abbreviated input', () => {
    const r = normalizeAddress('100 Sample Ln');
    expect(r.streetType).toBe('LN');
  });
});

describe('normalizeAddress — basic parsing', () => {
  it('parses house number, street, type', () => {
    const r = normalizeAddress('42 Elm Street');
    expect(r.houseNumber).toBe('42');
    expect(r.streetName).toBe('ELM');
    expect(r.streetType).toBe('ST');
  });

  it('handles pre-direction', () => {
    const r = normalizeAddress('100 N Main St');
    expect(r.preDirection).toBe('N');
    expect(r.streetName).toBe('MAIN');
    expect(r.streetType).toBe('ST');
  });

  it('handles post-direction', () => {
    const r = normalizeAddress('200 Park Ave NW');
    expect(r.streetType).toBe('AVE');
    expect(r.postDirection).toBe('NW');
  });

  it('handles compound street names', () => {
    const r = normalizeAddress('546 Old Haw Creek Rd');
    expect(r.streetName).toBe('OLD HAW CREEK');
    expect(r.streetType).toBe('RD');
  });

  it('extracts zip', () => {
    const r = normalizeAddress('42 Elm St, Asheville, NC 28801');
    expect(r.zip).toBe('28801');
    expect(r.state).toBe('NC');
  });

  it('produces multiple query forms in priority order', () => {
    const r = normalizeAddress('546 Old Haw Creek Rd, Asheville, NC 28805');
    expect(r.queryForms.length).toBeGreaterThan(0);
    expect(r.queryForms[0]).toBe('546 OLD HAW CREEK RD');
  });

  it('handles streets named after a direction (no false post-direction)', () => {
    const r = normalizeAddress('100 South Street');
    // "South" should be the street name, not a post-direction
    expect(r.streetType).toBe('ST');
    // streetName might be SOUTH because we matched the type token at end
    expect(r.streetName).toBe('SOUTH');
  });

  it('returns empty result for empty input', () => {
    const r = normalizeAddress('');
    expect(r.houseNumber).toBeUndefined();
    expect(r.streetName).toBeUndefined();
  });
});
