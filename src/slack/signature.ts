/**
 * Slack request signing verification.
 *
 * Slack signs every request with HMAC-SHA256 using your app's signing secret.
 * We verify every incoming request to be sure it came from Slack.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySlackSignature(opts: {
  signingSecret: string;
  timestamp: string | undefined;
  signature: string | undefined;
  rawBody: string;
  toleranceSeconds?: number;
}): boolean {
  const { signingSecret, timestamp, signature, rawBody } = opts;
  const tolerance = opts.toleranceSeconds ?? 60 * 5; // 5 min default

  if (!timestamp || !signature) return false;
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > tolerance) return false;

  const base = `v0:${timestamp}:${rawBody}`;
  const expected = 'v0=' + createHmac('sha256', signingSecret).update(base).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
