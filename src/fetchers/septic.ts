/**
 * septic — Buncombe County septic system data via spatial query.
 *
 * If a septic record intersects the parcel centroid, the property is on
 * septic; otherwise it's likely on public sewer (or unknown).
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.ts';
import { httpJson } from '../lib/http.ts';
import { SOURCES, arcgisQueryUrl } from '../sources/buncombe.ts';

export const septicFetcher: Fetcher = {
  id: 'septic',
  name: 'Septic / sewer status (REST)',
  counties: ['buncombe'],
  estimatedMs: 2_000,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });
    try {
      if (!ctx.property.centroid) {
        return { fetcher: this.id, status: 'skipped', files: [], error: 'No centroid', durationMs: Date.now() - t0 };
      }
      const { lon, lat } = ctx.property.centroid;
      const url = arcgisQueryUrl(SOURCES.septicLayer, {
        where: '1=1',
        geometry: JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } }),
        geometryType: 'esriGeometryPoint',
        inSR: '4326',
        distance: '75',
        units: 'esriSRUnit_Meter',
        spatialRel: 'esriSpatialRelIntersects',
        outFields: '*',
        returnGeometry: 'false',
      });
      const res = await httpJson<{ features?: Array<{ attributes: Record<string, unknown> }>; error?: { message: string } }>(url, {
        recorder: ctx.run.recorder,
        fetcherCallId: ctx.run.fetcherCallId,
        sourceLabel: 'buncombe.septic',
      });
      if (res.error) throw new Error(`septic query: ${res.error.message}`);

      const records = res.features ?? [];
      const onSeptic = records.length > 0;
      const summary = { onSeptic, records };

      const bytes = Buffer.from(JSON.stringify(summary, null, 2), 'utf8');
      const filename = `septic-${ctx.property.gisPin}.json`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'Septic data (JSON)',
        filename,
        contentType: 'application/json',
        bytes,
        sourceUrl: SOURCES.septicLayer,
      });

      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, filename);
      await writeFile(path, bytes);

      ctx.onProgress?.({
        fetcher: this.id,
        status: 'completed',
        file: path,
        message: onSeptic ? `On septic (${records.length} record(s))` : 'No septic record — likely public sewer',
      });

      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'Septic data (JSON)', contentType: 'application/json' }],
        data: { onSeptic, recordCount: records.length, artifactId: artifact.id, artifactSha256: artifact.sha256 },
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.onProgress?.({ fetcher: this.id, status: 'failed', error: msg });
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    }
  },
};
