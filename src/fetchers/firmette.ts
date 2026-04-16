/**
 * firmette — downloads the FEMA FIRMette flood map PDF.
 *
 * Two-phase approach (mirrors the working CLI version):
 *   1. Query NFHL REST API at the property centroid to find the FIRM panel ID.
 *   2. Download the FIRMette via msc.fema.gov/portal/downloadFirmette.
 *
 * If the NFHL query fails or returns no panel, falls back to portal address
 * search. Intercepts the PDF response directly since FEMA sometimes returns
 * it inline rather than as a download event.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, downloadToBuffer } from '../lib/browser.js';
import { femaFirmetteUrl } from '../sources/buncombe.js';

const NFHL_BASE = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const PANEL_LAYERS = [3, 0, 1, 2, 4, 5, 28, 29];

export const firmetteFetcher: Fetcher = {
  id: 'firmette',
  name: 'FEMA FIRMette flood map (PDF)',
  counties: ['buncombe'],
  estimatedMs: 60_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    // Phase 1: look up FIRM panel via REST
    let firmetteUrl: string | null = null;
    if (ctx.property.centroid) {
      firmetteUrl = await findFirmPanel(ctx.property.centroid.lon, ctx.property.centroid.lat);
    }

    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
      const page = await context.newPage();

      // Intercept inline PDF responses
      let interceptedPDF: Buffer | null = null;
      page.on('response', async (resp) => {
        try {
          const ct = resp.headers()['content-type'] ?? '';
          if (ct.includes('application/pdf') && !interceptedPDF) {
            interceptedPDF = Buffer.from(await resp.body());
          }
        } catch { /* ignore */ }
      });

      let bytes: Buffer | null = null;

      // Path A: direct firmette URL from NFHL
      if (firmetteUrl) {
        ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: `Downloading firmette…` });
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 45_000 }).catch(() => null),
          page.goto(firmetteUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}),
        ]);
        await page.waitForTimeout(3_000);

        if (download) bytes = await downloadToBuffer(download);
        else if (interceptedPDF) bytes = interceptedPDF;
        else {
          // Try embedded viewer src
          const embedSrc = await page.locator('embed[src], object[data], iframe[src]').first()
            .getAttribute('src').catch(() => null);
          if (embedSrc) {
            const embedUrl = embedSrc.startsWith('http') ? embedSrc : `https://msc.fema.gov${embedSrc}`;
            const [dl2] = await Promise.all([
              page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
              page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
            ]);
            if (dl2) bytes = await downloadToBuffer(dl2);
            else if (interceptedPDF) bytes = interceptedPDF;
          }
        }
      }

      // Path B: FEMA MSC portal address search fallback
      if (!bytes) {
        const address = ctx.property.address ?? '';
        ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Searching FEMA portal…' });
        await page.goto('https://msc.fema.gov/portal/home', { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

        const searchInput = page.locator('#txtAddressSearch');
        const visible = await searchInput.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true).catch(() => false);

        if (visible && address) {
          await searchInput.click();
          await searchInput.fill(address);
          await page.waitForTimeout(1_000);

          const searchBtn = page.locator('#addressLocate');
          if ((await searchBtn.count()) > 0) await searchBtn.click();
          else await page.keyboard.press('Enter');

          await page.waitForTimeout(10_000);
          await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

          // Look for FIRMette link
          const firmetteSelectors = [
            'a[href*="downloadFirmette"]',
            'a:has-text("FIRMette")',
            'a:has-text("FIRMETTE")',
            '#btnDynamicFirmette',
            'button:has-text("FIRMette")',
          ];
          for (const fsel of firmetteSelectors) {
            const link = page.locator(fsel).first();
            if (!(await link.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false))) continue;

            const href = await link.getAttribute('href').catch(() => null);
            if (href) {
              const fullUrl = href.startsWith('http') ? href : `https://msc.fema.gov${href}`;
              const [dl] = await Promise.all([
                page.waitForEvent('download', { timeout: 45_000 }).catch(() => null),
                page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}),
              ]);
              await page.waitForTimeout(3_000);
              if (dl) bytes = await downloadToBuffer(dl);
              else if (interceptedPDF) bytes = interceptedPDF;
              break;
            }

            // It's a button — click and check for download/interception
            await link.click().catch(() => {});
            await page.waitForTimeout(5_000);
            if (interceptedPDF) { bytes = interceptedPDF; break; }
          }
        }

        // Last resort: capture portal page as PDF
        if (!bytes) {
          bytes = Buffer.from(await page.pdf({
            format: 'Letter', printBackground: true,
            margin: { top: '0.25in', bottom: '0.25in', left: '0.25in', right: '0.25in' },
          }));
        }
      }

      const filename = `firmette-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'FEMA FIRMette (PDF)',
        filename,
        contentType: 'application/pdf',
        bytes: bytes!,
        sourceUrl: firmetteUrl ?? 'https://msc.fema.gov/portal/home',
      });

      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, filename);
      await writeFile(path, bytes!);

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: path });
      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'FEMA FIRMette (PDF)', contentType: 'application/pdf' }],
        data: { firmPanel: firmetteUrl ? extractPanel(firmetteUrl) : null, artifactId: artifact.id, artifactSha256: artifact.sha256 },
        durationMs: Date.now() - t0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.onProgress?.({ fetcher: this.id, status: 'failed', error: msg });
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    } finally {
      await browser.close();
    }
  },
};

/** Query NFHL REST for FIRM panel at a lon/lat. Returns firmette URL or null. */
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
    const url = `${NFHL_BASE}/${layerId}/query?${baseQuery}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
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
  return m ? decodeURIComponent(m[1]) : null;
}
