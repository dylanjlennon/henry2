import { describe, it, expect } from 'vitest';
import { inferPropertyFromChannelName } from '../../src/slack/channelName.ts';

describe('inferPropertyFromChannelName', () => {
  it('handles the real deal channel', () => {
    const r = inferPropertyFromChannelName('#546-old-haw-creek-rd');
    expect(r.confident).toBe(true);
    expect(r.guess).toBe('546 old haw creek rd');
  });

  it('works without a leading #', () => {
    const r = inferPropertyFromChannelName('123-main-st');
    expect(r.confident).toBe(true);
    expect(r.guess).toBe('123 main st');
  });

  it('strips "deal-" prefix', () => {
    const r = inferPropertyFromChannelName('deal-42-elm-st');
    expect(r.guess).toBe('42 elm st');
    expect(r.confident).toBe(true);
  });

  it('strips "closing" suffix', () => {
    const r = inferPropertyFromChannelName('100-main-st-closing');
    expect(r.guess).toBe('100 main st');
  });

  it('returns low confidence when no house number', () => {
    const r = inferPropertyFromChannelName('general-discussion');
    expect(r.confident).toBe(false);
  });

  it('returns undefined guess for empty input', () => {
    const r = inferPropertyFromChannelName('');
    expect(r.guess).toBeUndefined();
  });

  it('handles underscores', () => {
    const r = inferPropertyFromChannelName('42_elm_st');
    expect(r.guess).toBe('42 elm st');
    expect(r.confident).toBe(true);
  });
});
