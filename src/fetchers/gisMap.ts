/**
 * gisMap — exports the Buncombe County GIS viewer map as a PDF.
 *
 * TARGET URL:
 *   https://gis.buncombenc.gov/buncomap/Default.aspx?PINN={displayPin}
 *   (Built by gisMapViewerUrl() in src/sources/buncombe.ts)
 *   This is the county's own ESRI-powered interactive map viewer.
 *   The PINN parameter zooms and highlights the parcel on load.
 *
 * FLOW:
 *   1. Navigate to the viewer URL (waitUntil: load, 60s).
 *      We use 'load' not 'networkidle' because the ESRI JS app fires continuous
 *      tile requests that prevent networkidle from ever firing reliably.
 *   2. Dismiss the county disclaimer modal (button text: "Agree").
 *   3. Try to close any MapTip/info popup:
 *        CSS: .close, button:has-text("×"), button:has-text("Close"), .modal-close
 *   4. Wait for tile imagery to appear in DOM:
 *        CSS: #map img, .esriMapLayers img, canvas  (30s timeout, ignore if fails)
 *   5. Wait for networkidle (45s, swallow timeout). At this point the initial
 *      tile set has loaded, though canvas painting may still be in progress.
 *   6. Wait 5s extra render buffer. After networkidle, the browser still needs
 *      time to actually paint the canvas tiles — skipping this gives a grey map.
 *   7. Try to close the parcel info dialog that auto-opens on load:
 *        CSS: #InfoDialog .dijitDialogCloseIcon, .dijitDialogCloseIcon
 *
 *   PATH A — county's built-in PDF export (preferred):
 *   8. Click the Print button:
 *        CSS: #PrintDialog  (Dijit widget button in the ESRI toolbar)
 *   9. Wait 2s for the print panel to open, then click Export PDF:
 *        CSS: #exportPDFBtn
 *  10. Wait 3s for export to start, then wait for the "finished" indicator:
 *        CSS: #pdfRequestFinished:not([style*="display: none"])  (up to 90s)
 *      The county export server renders a true georeferenced PDF — slow but high quality.
 *  11. Wait 1s, then click the download link:
 *        CSS: #pdfLink
 *      waitForEvent('download', 60s). Save bytes.
 *
 *   PATH B — page.pdf() fallback (if PrintDialog or exportPDFBtn not found):
 *  12. page.pdf({ format: 'A3', landscape: true, printBackground: true })
 *      A3 landscape is chosen to match the aspect ratio of the GIS viewer.
 *
 *   SIZE VALIDATION:
 *  13. If bytes < 80KB: the map didn't fully render (county outline only, no tiles).
 *      Wait 10s, wait for networkidle again, then retry the download or re-capture.
 *      80KB threshold was calibrated against real captures — a full parcel map
 *      with aerial imagery is typically 400KB–2MB.
 *
 * WHAT CAN BREAK:
 *   - #PrintDialog, #exportPDFBtn, #pdfRequestFinished, #pdfLink IDs are ESRI
 *     widget IDs — they'll break if the county upgrades their ESRI viewer version
 *   - 5s canvas buffer is a guess; slower county servers may need 8–10s
 *   - 80KB threshold is not universal — very rural parcels with little imagery may be small
 *   - The county export server sometimes returns a 0-byte file; the fallback handles this
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

      // Wait for network to settle. ESRI maps do reach networkidle once the
      // initial tile set is loaded — this is more reliable than counting
      // cumulative resource entries (which only ever increases).
      await page.waitForLoadState('networkidle', { timeout: 45_000 }).catch(() => {});

      // Extra render buffer: after networkidle the browser still needs to
      // paint canvas tiles. 5s covers the typical Buncombe viewer render lag.
      await page.waitForTimeout(5_000);

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

      // Validate: a blank capture or county-outline-only PDF is typically < 80 KB.
      // If too small, wait another 10s and re-capture once.
      if (bytes.byteLength < 80_000) {
        await page.waitForTimeout(10_000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        try {
          const pdfLink = page.locator('#pdfLink').first();
          if ((await pdfLink.count()) > 0) {
            const [dl] = await Promise.all([
              page.waitForEvent('download', { timeout: 30_000 }),
              pdfLink.click({ timeout: 10_000 }),
            ]);
            bytes = await downloadToBuffer(dl);
          } else {
            bytes = Buffer.from(await page.pdf({ format: 'A3', printBackground: true, landscape: true }));
          }
        } catch {
          bytes = Buffer.from(await page.pdf({ format: 'A3', printBackground: true, landscape: true }));
        }
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

