import { describe, it, expect } from 'vitest';
import { looksLikePin, normalizePin } from '../../src/resolver/pin.ts';

describe('looksLikePin', () => {
  it('accepts dashed PIN', () => {
    expect(looksLikePin('9648-65-1234-00000')).toBe(true);
  });
  it('accepts plain digits', () => {
    expect(looksLikePin('964865123400000')).toBe(true);
  });
  it('rejects too short', () => {
    expect(looksLikePin('1234')).toBe(false);
  });
  it('rejects address strings', () => {
    expect(looksLikePin('42 Elm St')).toBe(false);
  });
});

describe('normalizePin', () => {
  it('produces both gisPin and displayPin', () => {
    const r = normalizePin('964865123400000');
    expect(r.gisPin).toBe('964865123400000');
    expect(r.displayPin).toBe('9648-65-1234-00000');
  });
  it('strips dashes', () => {
    const r = normalizePin('9648-65-1234-00000');
    expect(r.gisPin).toBe('964865123400000');
    expect(r.displayPin).toBe('9648-65-1234-00000');
  });
  it('throws on invalid length', () => {
    expect(() => normalizePin('123')).toThrow();
  });
});
