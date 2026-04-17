/**
 * septic — Buncombe County septic system data via spatial REST query.
 *
 * TARGET URL:
 *   https://services6.arcgis.com/VLA0ImJ33zhtGEaP/arcgis/rest/services/
 *     Buncombe%20County%20Septic%20Data/FeatureServer/0/query
 *   (Built by arcgisQueryUrl(SOURCES.septicLayer, ...) in src/sources/buncombe.ts)
 *
 * HOW IT WORKS:
 *   Sends a single spatial query: "give me all septic records within 75 meters
 *   of this parcel's centroid (lon/lat)."
 *
 *   The 75m buffer was chosen to reliably capture septic systems recorded at the
 *   tank or drainfield location, which are often offset from the parcel centroid
 *   by 20–50 meters for rural properties. A tighter buffer (e.g. 10m) misses
 *   edge-located systems; a wider buffer (e.g. 200m) picks up neighbors.
 *
 *   Query parameters:
 *     geometry: { x: lon, y: lat, spatialReference: { wkid: 4326 } }  (WGS84)
 *     geometryType: esriGeometryPoint
 *     distance: 75, units: esriSRUnit_Meter
 *     spatialRel: esriSpatialRelIntersects
 *     outFields: *  (return all attribute columns)
 *     returnGeometry: false  (we don't need the polygon, just attributes)
 *
 * RESULT INTERPRETATION:
 *   features.length > 0  → property has a recorded septic system → onSeptic: true
 *   features.length === 0 → no record within buffer → likely on public sewer (or unrecorded)
 *   Note: absence of a record doesn't guarantee public sewer — some rural properties
 *   have unrecorded or grandfathered systems.
 *
 * WHAT CAN BREAK:
 *   - Requires ctx.property.centroid (skips if missing)
 *   - ArcGIS service URL is hosted by county on ArcGIS Online — could move
 *   - Buffer distance may need tuning if false negatives increase
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { httpJson } from '../lib/http.js';
import { SOURCES, arcgisQueryUrl } from '../sources/buncombe.js';

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
