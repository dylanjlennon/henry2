/**
 * firmette — generates and downloads the FEMA FIRMette flood map.
 *
 * ROOT CAUSE OF THE ZOOM PROBLEM (now fixed):
 *   Previously we passed only the FIRM panel number (e.g. "3700966900J") to
 *   msc.fema.gov/portal/downloadFirmette?efsc=... FEMA requires a full EFSC
 *   (Extended FIRM Scale Code) that encodes panel + date + map coordinates.
 *   With just a panel number, FEMA redirects to the portal home page (302).
 *   We then fell back to screenshotting the dynamic web viewer at its default
 *   parcel-level zoom, producing a map far too zoomed in to show flood context.
 *
 * THE FIX — PrintFIRMette ArcGIS Geoprocessing Service:
 *   FEMA exposes a proper GP service that takes lat/lon and generates an
 *   official FIRMette image at the standard 1:6000 scale, properly centered
 *   on the property, with flood zone polygons, panel number, legend, and
 *   property marker. This is exactly what the user sees when they click
 *   "Get FIRMette" on msc.fema.gov after an address search.
 *
 *   Service URL:
 *     https://msc.fema.gov/arcgis/rest/services/NFHL_Print/MSCPrintB/GPServer/PrintFIRMette
 *
 *   Flow:
 *     1. POST /submitJob with Latitude + Longitude → returns { jobId }
 *     2. Poll /jobs/{jobId} every 3s until jobStatus = esriJobSucceeded (~9-15s)
 *     3. GET /jobs/{jobId}/results/OutputFile → URL of a 1-2 MB PNG file
 *     4. Download the PNG; embed it in a landscape A3 PDF.
 *
 * FALLBACK PATH (when GP service fails or property has no centroid):
 *   1. NFHL REST API → get FIRM_PAN panel number.
 *   2. Navigate to msc.fema.gov/portal/home in browser.
 *   3. Search by property address; wait 20s for SPA results.
 *   4. Intercept any network request to *downloadFirmette* — this captures
 *      the proper coordinate-embedded EFSC that the portal generates.
 *   5. Navigate to that URL and download the PDF.
 *   6. If still nothing: find dynamic viewer link, zoom it to level 13
 *      (≈ 2 mile radius, shows flood zones in context), screenshot → PDF.
 *
 * WHAT CAN BREAK:
 *   - GP service URL changes (FEMA has changed endpoint paths before)
 *   - Job poll timeout: normally 9-15s; can be 30-45s under load
 *   - Portal #txtAddressSearch / #addressLocate IDs change on portal update
 *   - Dynamic viewer zoom API: Leaflet map.setZoom(13) vs ESRI view.zoom=13
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, downloadToBuffer } from '../lib/browser.js';
import { femaFirmetteUrl } from '../sources/buncombe.js';

const NFHL_BASE = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const PANEL_LAYERS = [3, 0, 1, 2, 4, 5, 28, 29];
const PORTAL_HOME = 'https://msc.fema.gov/portal/home';
const PRINT_GP = 'https://msc.fema.gov/arcgis/rest/services/NFHL_Print/MSCPrintB/GPServer/PrintFIRMette';

export const firmetteFetcher: Fetcher = {
  id: 'firmette',
  name: 'FEMA FIRMette flood map (PDF)',
  counties: ['buncombe'],
  estimatedMs: 90_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    // ── PRIMARY PATH: PrintFIRMette GP service ────────────────────────────────
    // Requires a property centroid (lat/lon). Produces a 1-2 MB PNG at
    // standard 1:6000 FIRMette scale, centered on the property.
    if (ctx.property.centroid) {
      const { lat, lon } = ctx.property.centroid;
      try {
        ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: `Submitting FIRMette GP job (${lat.toFixed(5)}, ${lon.toFixed(5)})…` });

        // ArcGIS GP service GPDouble params must be JSON-structured, not plain strings
        const submitResp = await fetch(`${PRINT_GP}/submitJob`, {
          method: 'POST',
          body: new URLSearchParams({
            Latitude: JSON.stringify({ dataType: 'GPDouble', value: lat }),
            Longitude: JSON.stringify({ dataType: 'GPDouble', value: lon }),
            f: 'json',
          }),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Henry/2)' },
          signal: AbortSignal.timeout(20_000),
        });
        if (submitResp.ok) {
          const { jobId } = (await submitResp.json()) as { jobId?: string };
          if (jobId) {
            // Poll until complete (typically 9-15s, timeout at 90s)
            let pngUrl: string | null = null;
            for (let i = 0; i < 30; i++) {
              await new Promise((r) => setTimeout(r, 3_000));
              const poll = await fetch(`${PRINT_GP}/jobs/${jobId}?f=json`, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Henry/2)' },
                signal: AbortSignal.timeout(15_000),
              });
              const status = (await poll.json()) as { jobStatus: string };
              ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: `GP job: ${status.jobStatus}` });
              if (status.jobStatus === 'esriJobSucceeded') {
                const resultResp = await fetch(`${PRINT_GP}/jobs/${jobId}/results/OutputFile?f=json`, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Henry/2)' },
                  signal: AbortSignal.timeout(15_000),
                });
                const resultData = (await resultResp.json()) as {
                  value?: { url?: string };
                };
                pngUrl = resultData.value?.url ?? null;
                break;
              }
              if (status.jobStatus === 'esriJobFailed' || status.jobStatus === 'esriJobCancelled') break;
            }

            if (pngUrl) {
              ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Downloading FIRMette PNG…' });
              const pngResp = await fetch(pngUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Henry/2)' },
                signal: AbortSignal.timeout(30_000),
              });
              if (pngResp.ok) {
                const pngBytes = Buffer.from(await pngResp.arrayBuffer());
                if (pngBytes.byteLength > 50_000) {
                  // Need a browser page to embed PNG into PDF — launch one now
                  const b2 = await launchBrowser(ctx.signal);
                  try {
                    const pdfBytes = await pngToPdfVia(b2, pngBytes);
                    return await save(ctx, pdfBytes, PRINT_GP, t0, 'gp-service');
                  } finally {
                    await b2.close();
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        ctx.onProgress?.({
          fetcher: this.id, status: 'progress',
          message: `GP service failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        // fall through to browser fallback
      }
    }

    // ── FALLBACK: browser portal search ───────────────────────────────────────
    ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Falling back to portal search…' });

    // Also try NFHL REST for panel number (used if portal search finds nothing)
    let fallbackUrl: string | null = null;
    if (ctx.property.centroid) {
      fallbackUrl = await findFirmPanel(ctx.property.centroid.lon, ctx.property.centroid.lat);
    }

    const browser = await launchBrowser(ctx.signal);
    try {
      const bContext = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        acceptDownloads: true,
      });
      const page = await bContext.newPage();

      let interceptedPdf: Buffer | null = null;
      let interceptedFirmetteUrl: string | null = null;

      page.on('response', async (resp) => {
        try {
          if ((resp.headers()['content-type'] ?? '').includes('application/pdf') && !interceptedPdf) {
            const body = await resp.body();
            if (body.length > 10_000) interceptedPdf = Buffer.from(body);
          }
          if (resp.url().includes('downloadFirmette') && !interceptedFirmetteUrl) {
            interceptedFirmetteUrl = resp.url();
          }
        } catch { /* ignore */ }
      });

      let bytes: Buffer | null = null;

      // Portal search path
      const address = ctx.property.address ?? '';
      if (address) {
        await page.goto(PORTAL_HOME, { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

        const searchInput = page.locator('#txtAddressSearch');
        const searchVisible = await searchInput.isVisible({ timeout: 15_000 }).catch(() => false);
        if (searchVisible) {
          await searchInput.click();
          await searchInput.fill(address);
          await page.waitForTimeout(800);
          const searchBtn = page.locator('#addressLocate');
          if ((await searchBtn.count()) > 0) await searchBtn.click();
          else await page.keyboard.press('Enter');

          await page.waitForTimeout(20_000);
          await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

          const firmetteSelectors = [
            'a[href*="downloadFirmette"]',
            'a[href*="irmette"]',
            'a:has-text("FIRMette")',
            'a:has-text("FIRMETTE")',
            '#btnDynamicFirmette',
            'button:has-text("FIRMette")',
          ];
          let firmetteHref: string | null = null;
          for (const sel of firmetteSelectors) {
            const link = page.locator(sel).first();
            const visible = await link.isVisible({ timeout: 5_000 }).catch(() => false);
            if (!visible) continue;
            firmetteHref = await link.getAttribute('href').catch(() => null);
            if (firmetteHref) break;
            const [dl] = await Promise.all([
              page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
              link.click().catch(() => {}),
            ]);
            await page.waitForTimeout(8_000);
            if (dl) bytes = await downloadToBuffer(dl);
            if (bytes && bytes.byteLength > 10_000) break;
            if (interceptedPdf) { bytes = interceptedPdf; break; }
          }

          if (!bytes && (firmetteHref ?? interceptedFirmetteUrl)) {
            const rawUrl = (firmetteHref ?? interceptedFirmetteUrl)!;
            const targetUrl = rawUrl.startsWith('http') ? rawUrl : `https://msc.fema.gov${rawUrl}`;
            const [dl] = await Promise.all([
              page.waitForEvent('download', { timeout: 45_000 }).catch(() => null),
              page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}),
            ]);
            await page.waitForTimeout(15_000);
            await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
            if (dl) bytes = await downloadToBuffer(dl);
            else if (interceptedPdf) bytes = interceptedPdf;
          }
        }
      }

      // NFHL panel URL in browser
      if ((!bytes || bytes.byteLength <= 10_000) && fallbackUrl) {
        interceptedPdf = null;
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 45_000 }).catch(() => null),
          page.goto(fallbackUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}),
        ]);
        await page.waitForTimeout(15_000);
        if (dl) bytes = await downloadToBuffer(dl);
        else if (interceptedPdf) bytes = interceptedPdf;
      }

      // Dynamic viewer at zoom 13 (last resort)
      if (!bytes || bytes.byteLength <= 10_000) {
        const dynamicLink = await page.locator(
          'a[href*="dynamic"], a[href*="firmette"], a[href*="FIRMette"], #btnDynamicFirmette',
        ).first().getAttribute('href').catch(() => null);
        if (dynamicLink) {
          const dynUrl = dynamicLink.startsWith('http') ? dynamicLink : `https://msc.fema.gov${dynamicLink}`;
          await page.goto(dynUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        }
        await page.waitForTimeout(10_000);
        await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
        // Zoom out — level 13 ≈ 2 mile radius, enough to see flood zone context
        await page.evaluate(() => {
          try {
            const w = window as unknown as Record<string, unknown>;
            const maps = Object.values(w).filter(
              (v): v is Record<string, unknown> =>
                typeof v === 'object' && v !== null &&
                typeof (v as Record<string, unknown>)['setZoom'] === 'function',
            );
            for (const m of maps) (m['setZoom'] as (n: number) => void)(13);
          } catch { /* ignore */ }
        });
        await page.waitForTimeout(8_000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await page.waitForTimeout(5_000);
        const screenshot = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));
        bytes = await pngToPdfVia(browser, screenshot);
      }

      const sourceUrl = interceptedFirmetteUrl ?? fallbackUrl ?? PORTAL_HOME;
      return await save(ctx, bytes!, sourceUrl, t0, 'portal-browser');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.onProgress?.({ fetcher: this.id, status: 'failed', error: msg });
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    } finally {
      await browser.close();
    }
  },
};

async function pngToPdfVia(
  browser: import('playwright-core').Browser,
  pngBytes: Buffer,
): Promise<Buffer> {
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<html><body style="margin:0;padding:0;background:#fff">` +
      `<img src="data:image/png;base64,${pngBytes.toString('base64')}" style="width:100%;height:auto"/>` +
      `</body></html>`,
      { waitUntil: 'load' },
    );
    return Buffer.from(await page.pdf({ format: 'A3', landscape: true, printBackground: true }));
  } finally {
    await page.close();
  }
}

async function save(
  ctx: FetcherContext,
  bytes: Buffer,
  sourceUrl: string,
  t0: number,
  method: string,
): Promise<FetcherResult> {
  const filename = `firmette-${ctx.property.gisPin}.pdf`;
  const artifact = await ctx.run.recorder.putArtifact({
    fetcherCallId: ctx.run.fetcherCallId,
    label: 'FEMA FIRMette (PDF)',
    filename,
    contentType: 'application/pdf',
    bytes,
    sourceUrl,
  });
  await mkdir(ctx.outDir, { recursive: true });
  const path = join(ctx.outDir, filename);
  await writeFile(path, bytes);
  ctx.onProgress?.({ fetcher: 'firmette', status: 'completed', file: path });
  return {
    fetcher: 'firmette',
    status: 'completed',
    files: [{ path, label: 'FEMA FIRMette (PDF)', contentType: 'application/pdf' }],
    data: { method, panel: extractPanel(sourceUrl), artifactId: artifact.id, artifactSha256: artifact.sha256 },
    durationMs: Date.now() - t0,
  };
}

async function findFirmPanel(lon: number, lat: number): Promise<string | null> {
  const baseQuery = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
  });
  for (const layerId of PANEL_LAYERS) {
    try {
      const resp = await fetch(`${NFHL_BASE}/${layerId}/query?${baseQuery}`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) continue;
      const data = await resp.json().catch(() => ({}));
      if (data.error) continue;
      for (const feat of (data.features ?? [])) {
        const attrs = feat.attributes ?? {};
        const raw = attrs.FIRM_PAN ?? attrs.FIRM_ID ?? attrs.PANEL ?? attrs.FLD_AR_ID;
        const panel = raw ? String(raw).trim() : null;
        if (panel && panel.length >= 10 && panel !== 'null') {
          return femaFirmetteUrl(panel);
        }
      }
    } catch { /* try next layer */ }
  }
  return null;
}

function extractPanel(url: string): string | null {
  const m = url.match(/efsc=([^&]+)/);
  return m ? decodeURIComponent(m[1]).split('_')[0] : null;
}
