/**
 * VercelBlobArtifactStore — @vercel/blob-backed artifact storage.
 *
 * Artifacts are keyed by `${runId}/${filename}`. Blobs are stored with
 * `access: 'private'` (required by the store configuration). Downloads use
 * `Authorization: Bearer <token>` directly — the same method @vercel/blob's
 * own `get()` uses internally.
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
      access: 'private',
      contentType: opts.contentType,
      token: this.token,
      addRandomSuffix: false,
    });
    const sha256 = createHash('sha256').update(opts.bytes).digest('hex');
    return { storageUri: res.url, sha256, bytes: opts.bytes.byteLength };
  }

  async get(storageUri: string): Promise<Buffer> {
    // Private blobs require Bearer token authentication.
    const headers: Record<string, string> = {};
    if (this.token) headers['authorization'] = `Bearer ${this.token}`;
    const res = await fetch(storageUri, { headers });
    if (!res.ok) {
      throw new Error(`blob fetch failed: HTTP ${res.status} for ${storageUri}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async presign(storageUri: string): Promise<string> {
    const { head } = await import('@vercel/blob');
    const info = await head(storageUri, { token: this.token });
    return info.downloadUrl;
  }
}
