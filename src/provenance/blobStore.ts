/**
 * VercelBlobArtifactStore — @vercel/blob-backed artifact storage.
 *
 * Artifacts are keyed by `${runId}/${filename}`. The returned storageUri
 * is the Blob URL, which is publicly accessible by default — callers who
 * want access control should switch `access: 'private'` once Vercel Blob
 * supports it for their plan, and use `presign` to mint short-lived URLs.
 *
 * The store is transport-agnostic about the Vercel environment: in
 * production it reads `BLOB_READ_WRITE_TOKEN` from the env; in tests you
 * should use `FilesystemArtifactStore` from `memoryStore.ts` instead.
 */

import { createHash } from 'node:crypto';
import type { ArtifactStore } from './store.ts';

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
    const res = await fetch(storageUri);
    if (!res.ok) {
      throw new Error(`blob fetch failed: HTTP ${res.status} for ${storageUri}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  async presign(storageUri: string): Promise<string> {
    // Vercel Blob public URLs are already durable + directly servable.
    // When access: 'private' becomes available for our plan, this is where
    // we'd mint a time-limited URL.
    return storageUri;
  }
}
