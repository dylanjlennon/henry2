/**
 * sewerMap — captures the Buncombe County GIS map with the MSD Sewer Lines layer enabled.
 *
 * TARGET URL:
 *   https://gis.buncombecounty.org/buncomap/
 *   Same ESRI viewer as gisMap, but with the MSD Sewer Lines layer toggled ON.
 *
 * FLOW:
 *   1. Navigate to base URL (waitUntil: domcontentloaded, 60s).
 *   2. Wait for #viewDiv (20s) and networkidle (30s). Wait 5s extra.
 *   3. Dismiss disclaimer modal (button: "Agree").
 *   4. Dismiss InfoDialog if present.
 *   5. Search for the cleaned PIN (no hyphens) using the ESRI search widget.
 *      Try across all frames: .esri-search__input, input[placeholder*="Search"], input[type="text"]
 *   6. Press Enter, wait 10s for map to pan/zoom to parcel.
 *   7. Force zoom to level 17: window.map.setZoom(17) or setLevel(17).
 *   8. Enable "MSD Sewer Lines" layer:
 *      - Iterate all frames; find all input[type="checkbox"] elements.
 *      - For each checkbox, read its associated label text.
 *      - Match label containing "msd sewer lines" or "msd" + "sewer" + "lines".
 *      - If unchecked, click it and dispatch change/click events.
 *   9. Wait 3s for layer request, then wait for networkidle (30s) + 15s tile render.
 *  10. Screenshot (viewport, not fullPage) — avoids print-mode map shift.
 *  11. Embed screenshot PNG into a landscape Letter PDF via a temp browser page.
 *  12. Size check: if < 80 KB, wait 10s more and retry screenshot.
 *
 * WHAT CAN BREAK:
 *   - "MSD Sewer Lines" label text: if county renames the layer, the checkbox search fails
 *   - window.map.setZoom: ESRI 3.x API; ESRI 4.x uses view.zoom=
 *   - ESRI search widget selector changes on county server upgrade
 *   - 15s tile buffer may need more on slow county servers or complex parcels
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, dismissModal, cleanPIN } from '../lib/browser.js';

const MAP_URL = 'https://gis.buncombecounty.org/buncomap/';

export const sewerMapFetcher: Fetcher = {
  id: 'sewer-map',
  name: 'MSD Sewer map (Buncombe GIS)',
  counties: ['buncombe'],
  estimatedMs: 120_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    const browser = await launchBrowser(ctx.signal);
    try {
      const bContext = await browser.newContext({
        viewport: { width: 1600, height: 1200 },
        acceptDownloads: true,
      });
      const page = await bContext.newPage();

      // Step 1-2: Load map and wait
      await page.goto(MAP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
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
        const selectors = ['.esri-search__input', 'input[placeholder*="Search"]', 'input[placeholder*="search"]', 'input[type="text"]'];
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

      // Step 6: Wait for pan/zoom
      await page.waitForTimeout(10_000);

      // Step 7: Force zoom to 17
      await page.evaluate(() => {
        try {
          const m = (window as unknown as Record<string, unknown>).map as Record<string, unknown> | undefined;
          if (m && typeof m['setZoom'] === 'function') (m['setZoom'] as (n: number) => void)(17);
          else if (m && typeof m['setLevel'] === 'function') (m['setLevel'] as (n: number) => void)(17);
        } catch { /* ignore */ }
      });
      await page.waitForTimeout(4_000);

      // Step 8: Enable "MSD Sewer Lines" layer checkbox
      let layerEnabled = false;
      for (const frame of [page.mainFrame(), ...page.frames()]) {
        const result = await frame.evaluate(() => {
          const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
          for (const cb of checkboxes) {
            let label = '';
            const id = cb.getAttribute('id');
            if (id) {
              const el = document.querySelector(`label[for="${id}"]`);
              if (el) label = el.textContent ?? '';
            }
            if (!label) label = cb.parentElement?.textContent ?? '';
            const lower = label.toLowerCase();
            const match =
              lower.includes('msd sewer lines') ||
              (lower.includes('msd') && lower.includes('sewer') && lower.includes('lines'));
            if (match) {
              const was = (cb as HTMLInputElement).checked;
              if (!was) {
                (cb as HTMLInputElement).click();
                cb.dispatchEvent(new Event('change', { bubbles: true }));
              }
              return { found: true, label: label.slice(0, 80), was };
            }
          }
          return { found: false, label: '', was: false };
        });
        if (result.found) {
          ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: `Sewer layer: "${result.label}"` });
          layerEnabled = true;
          break;
        }
      }
      if (!layerEnabled) {
        ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'MSD Sewer layer checkbox not found' });
      }

      // Step 9: Wait for sewer tiles
      await page.waitForTimeout(3_000);
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(15_000);

      // Step 10: Screenshot
      let screenshot = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));

      // Step 12: Size check
      if (screenshot.byteLength < 80_000) {
        ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Map small, retrying…' });
        await page.waitForTimeout(10_000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        screenshot = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));
      }

      // Step 11: Embed screenshot in PDF
      let pdfBytes: Buffer;
      try {
        const htmlPage = await browser.newPage();
        await htmlPage.setContent(
          `<html><body style="margin:0;padding:0;background:#000">` +
          `<img src="data:image/png;base64,${screenshot.toString('base64')}" style="width:100%;height:auto"/>` +
          `</body></html>`,
          { waitUntil: 'load' },
        );
        pdfBytes = Buffer.from(await htmlPage.pdf({ format: 'A3', landscape: true, printBackground: true }));
        await htmlPage.close();
      } catch {
        pdfBytes = Buffer.from(await page.pdf({ format: 'A3', landscape: true, printBackground: true }));
      }

      const filename = `sewer-map-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'MSD Sewer map (PDF)',
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
        files: [{ path, label: 'MSD Sewer map (PDF)', contentType: 'application/pdf' }],
        data: { artifactId: artifact.id, artifactSha256: artifact.sha256, layerEnabled, searched },
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
