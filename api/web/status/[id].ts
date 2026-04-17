/**
 * GET /api/web/status/:id
 *
 * Lightweight polling endpoint for the web UI.
 * Returns fetcher statuses + artifact list for a web-originated run.
 * Public — no auth required. Only returns runs with trigger='web'.
 *
 * Poll every 2 s until status is 'completed', 'partial', or 'failed'.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeProvenanceStack } from '../../../src/provenance/factory.js';
import { log } from '../../../src/lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const runId = req.query.id as string;
  if (!runId) {
    res.status(400).json({ error: 'missing id' });
    return;
  }

  try {
    const { store } = await makeProvenanceStack();
    const status = await store.getWebRunStatus(runId);
    if (!status) {
      res.status(404).json({ error: 'run not found' });
      return;
    }
    res.status(200).json(status);
  } catch (err) {
    log.error('web_status_failed', { runId, err: String(err) });
    res.status(500).json({ error: 'internal error' });
  }
}
