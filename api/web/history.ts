/**
 * GET /api/web/history
 *
 * Returns recent web-UI runs for the public history feed.
 * Public — no auth required.
 *
 * Query params:
 *   ?limit=50    (default 50, max 100)
 *   ?cursor=ISO  (started_at timestamp for pagination)
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { log } from '../../src/lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 100);
  const cursor = (req.query.cursor as string | undefined) || undefined;

  try {
    const { store } = await makeProvenanceStack();
    const runs = await store.listWebRuns({ limit, cursor });
    res.status(200).json({ runs });
  } catch (err) {
    log.error('web_history_failed', { err: String(err) });
    res.status(500).json({ error: 'internal error' });
  }
}
