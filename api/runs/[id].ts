/**
 * GET /api/runs/:id — full RunTrace for a single run.
 *
 * Returns: { invocation, run, fetcherCalls, httpHits, artifacts }.
 *
 * Every URL we hit, the status / body sha256 / duration, every artifact
 * with its permanent storage URI — all traceable back to the originating
 * Slack message. This is the audit surface.
 *
 * Auth: Bearer HENRY_API_TOKEN if set.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeProvenanceStack } from '../../src/provenance/factory.ts';
import { log } from '../../src/lib/log.ts';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const id = req.query.id;
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'id required' });
    return;
  }
  try {
    const { store } = await makeProvenanceStack();
    const trace = await store.getRunTrace(id);
    if (!trace) {
      res.status(404).json({ error: 'run not found', id });
      return;
    }
    res.status(200).json(trace);
  } catch (err) {
    log.error('get_run_failed', { err: String(err), id });
    res.status(500).json({ error: 'internal error' });
  }
}

function isAuthorized(req: VercelRequest): boolean {
  const token = process.env.HENRY_API_TOKEN;
  if (!token) return true;
  const hdr = req.headers.authorization;
  return typeof hdr === 'string' && hdr === `Bearer ${token}`;
}
