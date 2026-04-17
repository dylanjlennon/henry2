/**
 * gisMap — exports the Buncombe County GIS parcel map as a PDF.
 *
 * TARGET URL:
 *   https://gis.buncombecounty.org/buncomap/
 *   (Base URL; we search for the PIN inside the app rather than using URL params,
 *    because the PINN= query param does not reliably set the zoom level.)
 *
 * FLOW:
 *   1. Navigate to base URL (waitUntil: domcontentloaded, 60s).
 *   2. Wait for map container: #viewDiv (20s) and networkidle (30s).
 *   3. Dismiss disclaimer modal (button text: "Agree").
 *   4. Dismiss InfoDialog if it auto-opens:
 *        CSS: #InfoDialog button, .dijitDialogCloseIcon
 *        Also remove the underlay via JS if needed.
 *   5. Find the search widget across all frames and type the cleaned PIN (no hyphens).
 *      Try selectors: .esri-search__input, input[placeholder*="Search"], input[type="text"]
 *   6. Press Enter, wait 10s for map to pan/zoom to parcel.
 *   7. Force zoom to level 17 via JS: window.map.setZoom(17) or window.map.setLevel(17).
 *      Zoom 17 shows the parcel clearly with ~2-3 block radius of surrounding context.
 *   8. Wait 8s render buffer — after zoom, tiles repaint asynchronously.
 *   9. Wait for networkidle (30s), then 5s extra buffer.
 *  10. Take a full-viewport screenshot (not page.pdf() — switching to print mode
 *      shifts the map viewport, producing a county-outline-only capture).
 *  11. Embed the screenshot PNG into a Landscape Letter PDF using browser canvas:
 *        page.evaluate() draws the image onto a canvas and exports PDF bytes.
 *      Fallback: page.pdf(A3 landscape) if screenshot embed fails.
 *
 * SIZE VALIDATION:
 *  12. If bytes < 80 KB the map didn't fully render. Wait 10s more and retry screenshot.
 *      80 KB calibrated from real captures — a zoomed parcel map with aerial tiles
 *      is typically 400 KB – 2 MB; the blank county-outline is ~35 KB.
 *
 * WHAT CAN BREAK:
 *   - window.map.setZoom / setLevel: ESRI 3.x API; breaks if county upgrades to 4.x (use view.zoom= instead)
 *   - Search widget selectors (.esri-search__input) change between ESRI versions
 *   - 8s tile render buffer may need 12-15s on slow county servers
 *   - The InfoDialog DOM IDs are Dijit widget IDs; they change on ESRI upgrade
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, dismissModal, cleanPIN } from '../lib/browser.js';

const MAP_URL = 'https://gis.buncombecounty.org/buncomap/';

export const gisMapFetcher: Fetcher = {
  id: 'gis-map',
  name: 'GIS parcel map (Buncombe)',
  counties: ['buncombe'],
  estimatedMs: 90_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({
        viewport: { width: 1600, height: 1200 },
        acceptDownloads: true,
      });
      const page = await context.newPage();

      // Step 1: Load base map URL
      await page.goto(MAP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Step 2: Wait for map container and network to settle
      try { await page.waitForSelector('#viewDiv', { state: 'visible', timeout: 20_000 }); } catch { /* proceed */ }
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      // Step 3: Dismiss disclaimer
      await dismissModal(page, ['Agree', 'Accept', 'OK']);

      // Step 4: Dismiss InfoDialog
      try {
        const infoVisible = await page.locator('#InfoDialog').isVisible({ timeout: 3_000 }).catch(() => false);
        if (infoVisible) {
          const closeBtn = page.locator('#InfoDialog button, #InfoDialog .dijitDialogCloseIcon').first();
          if ((await closeBtn.count()) > 0) await closeBtn.click({ timeout: 3_000 });
          // Also nuke the underlay via JS in case it blocks interaction
          await page.evaluate(() => {
            const underlay = document.querySelector('#InfoDialog_underlay, .dijitDialogUnderlay') as HTMLElement | null;
            if (underlay) underlay.remove();
            const dialog = document.querySelector('#InfoDialog') as HTMLElement | null;
            if (dialog) dialog.style.display = 'none';
          });
          await page.waitForTimeout(1_000);
        }
      } catch { /* ignore */ }

      // Step 5: Search for the PIN
      const pinClean = cleanPIN(ctx.property.pin);
      let searched = false;
      const frames = page.frames();
      for (const frame of [page.mainFrame(), ...frames]) {
        const selectors = [
          '.esri-search__input',
          'input[placeholder*="Search"]',
          'input[placeholder*="search"]',
          'input[placeholder*="Find"]',
          'input[aria-label*="Search"]',
          'input[type="text"]',
        ];
        for (const sel of selectors) {
          try {
            const input = frame.locator(sel).first();
            if ((await input.count()) > 0 && await input.isVisible({ timeout: 2_000 })) {
              await input.click();
              await input.fill(pinClean);
              await page.waitForTimeout(1_000);
              await page.keyboard.press('Enter');
              searched = true;
              break;
            }
          } catch { continue; }
        }
        if (searched) break;
      }

      // Step 6: Wait for map to pan/zoom to parcel
      await page.waitForTimeout(10_000);

      // Step 7: Force zoom to level 17 so parcel fills the viewport
      const zoomSet = await page.evaluate(() => {
        try {
          const m = (window as unknown as Record<string, unknown>).map as Record<string, unknown> | undefined;
          if (m && typeof m['setZoom'] === 'function') {
            (m['setZoom'] as (n: number) => void)(17);
            return 'setZoom';
          } else if (m && typeof m['setLevel'] === 'function') {
            (m['setLevel'] as (n: number) => void)(17);
            return 'setLevel';
          }
          return 'not-found';
        } catch (e) {
          return String(e);
        }
      });
      ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: `zoom: ${zoomSet}` });

      // Step 8-9: Wait for tile repaint
      await page.waitForTimeout(8_000);
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(5_000);

      // Step 10: Screenshot (avoids the print-mode map shift problem)
      let bytes: Buffer = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));

      // Step 12: Validate size — retry if county outline only
      if (bytes.byteLength < 80_000) {
        ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Map render too small, retrying…' });
        await page.waitForTimeout(10_000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        bytes = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));
      }

      // Step 11: Embed screenshot PNG into a landscape PDF via page.pdf()
      // We create a temporary data-URL page so page.pdf() captures the image
      // without switching to print mode on the live GIS map.
      let pdfBytes: Buffer;
      try {
        const base64 = bytes.toString('base64');
        const htmlPage = await browser.newPage();
        await htmlPage.setContent(
          `<html><body style="margin:0;padding:0;background:#000">` +
          `<img src="data:image/png;base64,${base64}" style="width:100%;height:auto"/>` +
          `</body></html>`,
          { waitUntil: 'load' },
        );
        pdfBytes = Buffer.from(await htmlPage.pdf({ format: 'A3', landscape: true, printBackground: true }));
        await htmlPage.close();
      } catch {
        // Ultimate fallback: PDF from the live map page
        pdfBytes = Buffer.from(await page.pdf({ format: 'A3', landscape: true, printBackground: true }));
      }

      const filename = `gis-map-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'GIS parcel map (PDF)',
        filename,
        contentType: 'application/pdf',
        bytes: pdfBytes,
        sourceUrl: MAP_URL,
      });

      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, filename);
      await writeFile(path, pdfBytes);

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: path });
      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'GIS parcel map (PDF)', contentType: 'application/pdf' }],
        data: { artifactId: artifact.id, artifactSha256: artifact.sha256, zoomed: zoomSet, searched },
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
