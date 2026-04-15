import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifySlackSignature } from '../../src/slack/signature.ts';

function sign(secret: string, ts: string, body: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex');
}

describe('verifySlackSignature', () => {
  const secret = 'test-signing-secret';
  const body = 'token=xxx&text=546+Old+Haw+Creek+Rd';

  it('accepts valid signature with fresh timestamp', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(secret, ts, body);
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body }),
    ).toBe(true);
  });

  it('rejects stale timestamp', () => {
    const ts = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = sign(secret, ts, body);
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body }),
    ).toBe(false);
  });

  it('rejects tampered body', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign(secret, ts, body);
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: ts,
        signature: sig,
        rawBody: body + '&extra=1',
      }),
    ).toBe(false);
  });

  it('rejects missing headers', () => {
    expect(
      verifySlackSignature({
        signingSecret: secret,
        timestamp: undefined,
        signature: undefined,
        rawBody: body,
      }),
    ).toBe(false);
  });

  it('rejects wrong signing secret', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = sign('wrong-secret', ts, body);
    expect(
      verifySlackSignature({ signingSecret: secret, timestamp: ts, signature: sig, rawBody: body }),
    ).toBe(false);
  });
});
