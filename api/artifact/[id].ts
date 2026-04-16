/**
 * GET /api/artifact/:id — proxy artifact bytes from the blob/filesystem store.
 *
 * Looks up the artifact metadata in Neon, fetches the bytes from the artifact
 * store (presigning private Vercel Blob URLs as needed), and streams them back
 * with the correct Content-Type. This is the canonical way to retrieve a
 * stored document externally without exposing the raw blob URL.
 *
 * Auth: Bearer HENRY_API_TOKEN if set.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { log } from '../../src/lib/log.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET') {
    res.status(405).end();
    return;
  }
  if (!isAuthorized(req)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (!id) {
    res.status(400).json({ error: 'id required' });
    return;
  }

  try {
    const { store, artifactStore } = await makeProvenanceStack();
    const artifact = await store.getArtifact(id);
    if (!artifact) {
      res.status(404).json({ error: 'artifact not found', id });
      return;
    }

    const bytes = await artifactStore.get(artifact.storageUri);

    // Sanitize the label for use as a download filename.
    const safeName = artifact.label.replace(/[^a-zA-Z0-9._\- ]/g, '_').trim() || 'artifact';
    const ext = artifact.contentType === 'application/pdf' ? '.pdf'
      : artifact.contentType === 'application/json' ? '.json'
      : '';
    const filename = safeName.endsWith(ext) ? safeName : `${safeName}${ext}`;

    res.setHeader('Content-Type', artifact.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(bytes.byteLength));
    res.status(200).end(bytes);
  } catch (err) {
    log.error('artifact_download_failed', { err: String(err), id });
    res.status(500).json({ error: 'internal error' });
  }
}

function isAuthorized(req: VercelRequest): boolean {
  const token = process.env.HENRY_API_TOKEN;
  if (!token) return true;
  const hdr = req.headers.authorization;
  return typeof hdr === 'string' && hdr === `Bearer ${token}`;
}
