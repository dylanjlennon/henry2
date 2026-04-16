/**
 * GET /api/runs — list recent runs (newest first).
 *
 *   ?limit=50  (default 50, max 200)
 *   ?offset=0
 *
 * Returns a JSON array of Run records (sans fetcher/HTTP/artifact detail).
 * Auth: requires a Bearer token matching HENRY_API_TOKEN if set.
 * Without HENRY_API_TOKEN configured, the endpoint serves publicly — fine
 * for local dev, but set a token in production.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { log } from '../../src/lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const limit = Math.min(parseInt((req.query.limit as string) ?? '50', 10) || 50, 200);
  const offset = parseInt((req.query.offset as string) ?? '0', 10) || 0;
  try {
    const { store } = await makeProvenanceStack();
    const runs = await store.listRuns({ limit, offset });
    res.status(200).json({ runs, limit, offset });
  } catch (err) {
    log.error('list_runs_failed', { err: String(err) });
    res.status(500).json({ error: 'internal error' });
  }
}

function isAuthorized(req: VercelRequest): boolean {
  const token = process.env.HENRY_API_TOKEN;
  if (!token) return true;
  const hdr = req.headers.authorization;
  return typeof hdr === 'string' && hdr === `Bearer ${token}`;
}
