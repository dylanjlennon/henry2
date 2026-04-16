/**
 * VercelBlobArtifactStore — @vercel/blob-backed artifact storage.
 *
 * Artifacts are keyed by `${runId}/${filename}`. Blobs are stored with
 * `access: 'public'` so they can be fetched without token authentication.
 * Access control is handled at the Slack workspace level — these are
 * internal compliance documents posted to a private workspace.
 *
 * The store is transport-agnostic about the Vercel environment: in
 * production it reads `BLOB_READ_WRITE_TOKEN` from the env; in tests you
 * should use `FilesystemArtifactStore` from `memoryStore.ts` instead.
 */

import { createHash } from 'node:crypto';
import type { ArtifactStore } from './store.js';

export interface VercelBlobArtifactStoreOptions {
  /** Overrides the BLOB_READ_WRITE_TOKEN env var. */
  token?: string;
  /** Pathname prefix (default `"artifacts"`). */
  pathPrefix?: string;
}

export class VercelBlobArtifactStore implements ArtifactStore {
  private readonly token: string | undefined;
  private readonly prefix: string;

  constructor(opts: VercelBlobArtifactStoreOptions = {}) {
    this.token = opts.token ?? process.env.BLOB_READ_WRITE_TOKEN;
    this.prefix = (opts.pathPrefix ?? 'artifacts').replace(/\/+$/, '');
  }

  async put(opts: {
    runId: string;
    filename: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<{ storageUri: string; sha256: string; bytes: number }> {
    const { put } = await import('@vercel/blob');
    const key = `${this.prefix}/${opts.runId}/${opts.filename}`;
    const res = await put(key, opts.bytes, {
      access: 'public',
      contentType: opts.contentType,
      token: this.token,
      addRandomSuffix: false,
    });
    const sha256 = createHash('sha256').update(opts.bytes).digest('hex');
    return { storageUri: res.url, sha256, bytes: opts.bytes.byteLength };
  }

  async get(storageUri: string): Promise<Buffer> {
    // Try direct fetch first (works for public blobs and new runs).
    // Fall back to Bearer token auth for legacy private blobs.
    const direct = await fetch(storageUri);
    if (direct.ok) {
      return Buffer.from(await direct.arrayBuffer());
    }
    if (direct.status === 403 && this.token) {
      const authed = await fetch(storageUri, {
        headers: { authorization: `Bearer ${this.token}` },
      });
      if (!authed.ok) {
        throw new Error(`blob fetch failed: HTTP ${authed.status} for ${storageUri}`);
      }
      return Buffer.from(await authed.arrayBuffer());
    }
    throw new Error(`blob fetch failed: HTTP ${direct.status} for ${storageUri}`);
  }

  async presign(storageUri: string): Promise<string> {
    // Public blobs are directly accessible — return the URL as-is.
    return storageUri;
  }
}
