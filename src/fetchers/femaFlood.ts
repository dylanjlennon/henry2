/**
 * femaFlood — queries the FEMA NFHL REST API for flood zone & FIRM panel info.
 *
 * Two spatial queries:
 *   1. Flood Hazard Zones (layer 28) → zone code, BFE, SFHA flag
 *   2. FIRM Panels (layer 16)        → panel ID for FIRMette generation later
 *
 * Pure REST. The actual FIRMette PDF is fetched by a separate browser
 * fetcher because msc.fema.gov requires a session.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.ts';
import { httpJson } from '../lib/http.ts';
import { SOURCES, arcgisQueryUrl } from '../sources/buncombe.ts';

interface FloodZoneAttrs {
  FLD_ZONE?: string;
  ZONE_SUBTY?: string;
  SFHA_TF?: string;
  STATIC_BFE?: number;
  DEPTH?: number;
  FLD_AR_ID?: string;
}
interface FirmPanelAttrs {
  FIRM_PAN?: string;
  PANEL?: string;
  EFF_DATE?: number;
  PANEL_TYP?: string;
}

export const femaFloodFetcher: Fetcher = {
  id: 'fema-flood',
  name: 'FEMA flood zone (REST)',
  counties: ['buncombe'],
  estimatedMs: 3_000,
  needsBrowser: false,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });
    try {
      if (!ctx.property.centroid) {
        return skipped(this.id, 'No centroid available', t0);
      }
      const { lon, lat } = ctx.property.centroid;
      const geometry = JSON.stringify({ x: lon, y: lat, spatialReference: { wkid: 4326 } });

      // Run both queries in parallel
      const [zoneRes, panelRes] = await Promise.all([
        httpJson<{ features?: Array<{ attributes: FloodZoneAttrs }>; error?: { message: string } }>(
          arcgisQueryUrl(SOURCES.femaNflhFloodZones, {
            where: '1=1',
            geometry,
            geometryType: 'esriGeometryPoint',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,DEPTH,FLD_AR_ID',
            returnGeometry: 'false',
          }),
        ),
        httpJson<{ features?: Array<{ attributes: FirmPanelAttrs }>; error?: { message: string } }>(
          arcgisQueryUrl(SOURCES.femaNflhFirmPanels, {
            where: '1=1',
            geometry,
            geometryType: 'esriGeometryPoint',
            inSR: '4326',
            spatialRel: 'esriSpatialRelIntersects',
            outFields: 'FIRM_PAN,PANEL,EFF_DATE,PANEL_TYP',
            returnGeometry: 'false',
          }),
        ),
      ]);

      if (zoneRes.error) throw new Error(`flood zones: ${zoneRes.error.message}`);
      if (panelRes.error) throw new Error(`FIRM panels: ${panelRes.error.message}`);

      const zone = zoneRes.features?.[0]?.attributes;
      const panel = panelRes.features?.[0]?.attributes;
      const summary = {
        floodZone: zone?.FLD_ZONE ?? 'NOT MAPPED',
        zoneSubtype: zone?.ZONE_SUBTY,
        inSpecialFloodHazardArea: zone?.SFHA_TF === 'T',
        baseFloodElevation: zone?.STATIC_BFE,
        depth: zone?.DEPTH,
        firmPanel: panel?.FIRM_PAN ?? panel?.PANEL,
        firmPanelType: panel?.PANEL_TYP,
        firmPanelEffectiveDate: panel?.EFF_DATE,
      };

      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, `fema-flood-${ctx.property.gisPin}.json`);
      await writeFile(path, JSON.stringify({ summary, raw: { zone, panel } }, null, 2));

      ctx.onProgress?.({
        fetcher: this.id,
        status: 'completed',
        file: path,
        message: `Flood zone: ${summary.floodZone}`,
      });

      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'FEMA flood data (JSON)', contentType: 'application/json' }],
        data: summary,
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.onProgress?.({ fetcher: this.id, status: 'failed', error: msg });
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    }
  },
};

function skipped(id: string, msg: string, t0: number): FetcherResult {
  return { fetcher: id, status: 'skipped', files: [], error: msg, durationMs: Date.now() - t0 };
}
