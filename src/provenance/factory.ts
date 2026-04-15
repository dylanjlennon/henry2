/**
 * Provenance store factory — chooses backends based on environment.
 *
 *   PROVENANCE_BACKEND=memory   (default in tests / local dev)
 *   PROVENANCE_BACKEND=postgres (prod — requires DATABASE_URL)
 *
 *   ARTIFACT_BACKEND=filesystem (default in tests / local dev)
 *   ARTIFACT_BACKEND=vercel-blob (prod — requires BLOB_READ_WRITE_TOKEN)
 *
 * One switch, one line. The rest of the codebase imports
 * `makeProvenanceStack()` and doesn't care which backend it got.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ArtifactStore, ProvenanceStore } from './store.ts';
import { FilesystemArtifactStore, MemoryProvenanceStore } from './memoryStore.ts';

export interface ProvenanceStack {
  store: ProvenanceStore;
  artifactStore: ArtifactStore;
  /** Free-form label for the chosen backends; good for logs. */
  backendLabel: string;
}

export async function makeProvenanceStack(): Promise<ProvenanceStack> {
  const backend = process.env.PROVENANCE_BACKEND ?? 'memory';
  const artifactBackend = process.env.ARTIFACT_BACKEND ?? 'filesystem';

  const store = await buildStore(backend);
  const artifactStore = await buildArtifactStore(artifactBackend);

  return {
    store,
    artifactStore,
    backendLabel: `${backend}+${artifactBackend}`,
  };
}

async function buildStore(backend: string): Promise<ProvenanceStore> {
  switch (backend) {
    case 'memory':
      return new MemoryProvenanceStore();
    case 'postgres': {
      const { PostgresProvenanceStore, getSharedPool } = await import('./postgresStore.ts');
      return new PostgresProvenanceStore({ pool: await getSharedPool() });
    }
    default:
      throw new Error(`Unknown PROVENANCE_BACKEND: ${backend}`);
  }
}

async function buildArtifactStore(backend: string): Promise<ArtifactStore> {
  switch (backend) {
    case 'filesystem': {
      const root = process.env.ARTIFACT_ROOT ?? join(tmpdir(), 'henry-artifacts');
      return new FilesystemArtifactStore(root);
    }
    case 'vercel-blob': {
      const { VercelBlobArtifactStore } = await import('./blobStore.ts');
      return new VercelBlobArtifactStore();
    }
    default:
      throw new Error(`Unknown ARTIFACT_BACKEND: ${backend}`);
  }
}
