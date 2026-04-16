/**
 * gisMap — exports the Buncombe County GIS viewer map as a PDF.
 *
 * Navigates to the PINN-parameterized viewer URL, waits for tile layers to
 * stabilize, then uses the built-in Export PDF mechanism. Falls back to
 * page.pdf() if the export widget is unavailable.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, dismissModal, downloadToBuffer } from '../lib/browser.js';
import { gisMapViewerUrl } from '../sources/buncombe.js';

export const gisMapFetcher: Fetcher = {
  id: 'gis-map',
  name: 'GIS parcel map (Buncombe)',
  counties: ['buncombe'],
  estimatedMs: 60_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
      const page = await context.newPage();
      const url = gisMapViewerUrl(ctx.property.pin);

      // Use 'load' not 'networkidle' — ESRI tile maps make continuous network
      // requests for map tiles that never settle to networkidle.
      await page.goto(url, { waitUntil: 'load', timeout: 60_000 });
      await dismissModal(page, ['Agree']);

      // Close any MapTip or info modals
      try {
        const closeBtn = page.locator('.close, button:has-text("×"), button:has-text("Close"), .modal-close').first();
        if ((await closeBtn.count()) > 0) await closeBtn.click({ timeout: 5_000 });
      } catch { /* ignore */ }

      // Wait for tile imagery to appear
      try {
        await page.waitForSelector('#map img, .esriMapLayers img, canvas', { timeout: 30_000 });
      } catch { /* proceed anyway */ }
      await page.waitForTimeout(5_000);

      // Poll until tile requests stabilize
      for (let i = 0; i < 6; i++) {
        const before = await tileCount(page);
        await page.waitForTimeout(2_000);
        const after = await tileCount(page);
        if (after === before) break;
      }
      await page.waitForTimeout(3_000);

      // Close info dialog if it opened after selecting the parcel
      try {
        const closeDialog = page.locator('#InfoDialog .dijitDialogCloseIcon, .dijitDialogCloseIcon').first();
        if ((await closeDialog.count()) > 0) await closeDialog.click({ timeout: 5_000 });
      } catch { /* ignore */ }

      let bytes: Buffer;

      try {
        const printDialog = page.locator('#PrintDialog').first();
        if ((await printDialog.count()) === 0) throw new Error('PrintDialog not found');

        await printDialog.click({ timeout: 10_000 });
        await page.waitForTimeout(2_000);

        const exportBtn = page.locator('#exportPDFBtn').first();
        if ((await exportBtn.count()) === 0) throw new Error('exportPDFBtn not found');

        await exportBtn.click({ timeout: 10_000 });
        await page.waitForTimeout(3_000);

        // Wait for the export to finish (county export can be slow)
        await page.waitForSelector('#pdfRequestFinished:not([style*="display: none"])', { timeout: 90_000 });
        await page.waitForTimeout(1_000);

        const pdfLink = page.locator('#pdfLink').first();
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 60_000 }),
          pdfLink.click({ timeout: 10_000 }),
        ]);
        bytes = await downloadToBuffer(download);
      } catch {
        // Fall back: capture the rendered page as PDF
        bytes = Buffer.from(await page.pdf({ format: 'A3', printBackground: true, landscape: true }));
      }

      const filename = `gis-map-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'GIS parcel map (PDF)',
        filename,
        contentType: 'application/pdf',
        bytes,
        sourceUrl: url,
      });

      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, filename);
      await writeFile(path, bytes);

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: path });
      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'GIS parcel map (PDF)', contentType: 'application/pdf' }],
        data: { artifactId: artifact.id, artifactSha256: artifact.sha256 },
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

async function tileCount(page: import('playwright-core').Page): Promise<number> {
  return page.evaluate(() =>
    performance.getEntriesByType('resource')
      .filter((r) => r.name.includes('arcgis') || r.name.includes('tile') || r.name.includes('MapServer'))
      .length,
  ).catch(() => 0);
}
