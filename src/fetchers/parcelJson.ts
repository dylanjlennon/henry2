/**
 * parcelJson — saves the raw parcel record from the GIS REST API as JSON.
 *
 * Pure REST. No browser. Always succeeds if the property resolved (because
 * resolution itself comes from the same API). Useful as the lightweight
 * "always-on" fetch and as a sanity check that the orchestrator works.
 *
 * Every HTTP call flows through the provenance recorder; the produced JSON
 * blob is persisted via ArtifactStore so it gets a sha256 + durable URI.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.ts';
import { lookupParcelByPin } from '../resolver/adapters/buncombe.ts';
import { SOURCES } from '../sources/buncombe.ts';

export const parcelJsonFetcher: Fetcher = {
  id: 'parcel-json',
  name: 'Parcel record (GIS REST)',
  counties: ['buncombe'],
  estimatedMs: 1_500,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });
    try {
      const hit = await lookupParcelByPin(ctx.property.gisPin, {
        recorder: ctx.run.recorder,
        fetcherCallId: ctx.run.fetcherCallId,
      });
      if (!hit) return failed(this.id, 'Parcel not found in GIS', t0);

      const bytes = Buffer.from(JSON.stringify(hit, null, 2), 'utf8');
      const filename = `parcel-${ctx.property.gisPin}.json`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'Parcel record (JSON)',
        filename,
        contentType: 'application/json',
        bytes,
        sourceUrl: SOURCES.parcelLayer,
      });

      // Also keep the legacy on-disk copy so Slack upload + tests still work.
      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, filename);
      await writeFile(path, bytes);

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: path });
      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'Parcel record (JSON)', contentType: 'application/json' }],
        data: {
          attributes: hit.attributes,
          centroid: hit.centroid,
          artifactId: artifact.id,
          artifactSha256: artifact.sha256,
        },
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      return failed(this.id, errMsg(err), t0);
    }
  },
};

function failed(id: string, msg: string, t0: number): FetcherResult {
  return { fetcher: id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
