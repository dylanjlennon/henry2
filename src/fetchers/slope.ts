/**
 * slope — calculates parcel slope from MapWNC and captures the results as PDF.
 *
 * TARGET URL:
 *   https://www.mapwnc.org/find-slope-for-parcel
 *   MapWNC is a Western NC GIS tool that calculates average slope for a parcel
 *   given its PIN. Results include slope percentage, degrees, and a map view.
 *
 * FLOW:
 *   1. Navigate to https://www.mapwnc.org/find-slope-for-parcel
 *      (waitUntil: networkidle, 30s).
 *   2. Wait 2s, then dismiss any modals: 'Accept', 'OK', 'Close', 'Continue'.
 *   3. Fill the PIN input with the cleaned PIN (no hyphens):
 *        CSS: input[type="text"], input[placeholder*="PIN"]
 *   4. Click the Calculate button:
 *        CSS: button:has-text("Calculate"), input[type="submit"]
 *   5. Wait for results to appear (up to 15s):
 *        JS poll: document.body.textContent includes "Slope" OR "%" OR a results table
 *        Fallback: waitForLoadState('networkidle') after timeout.
 *   6. Wait 3s extra for full render.
 *   7. Capture PDF: page.pdf(Letter, portrait, printBackground: true).
 *
 * WHAT CAN BREAK:
 *   - mapwnc.org URL or input selector changes
 *   - Results may load as an iframe or redirect — waitForFunction may miss them
 *   - Condo PINs (with "C") may not be accepted by MapWNC; try base 10-digit PIN
 *   - The site may require the 15-digit PIN without hyphens OR the dashed display form
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, dismissModal, pdfOptions } from '../lib/browser.js';

const SLOPE_URL = 'https://www.mapwnc.org/find-slope-for-parcel';

export const slopeFetcher: Fetcher = {
  id: 'slope',
  name: 'Slope calculation (MapWNC)',
  counties: ['buncombe'],
  estimatedMs: 60_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const page = await context.newPage();

      // Step 1: Load slope calculator
      await page.goto(SLOPE_URL, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      // Step 2: Dismiss modals
      await dismissModal(page, ['Accept', 'OK', 'Close', 'Continue', 'I Agree']);

      // Step 3: Enter PIN (no hyphens; for condo PINs try base 10-digit PIN)
      let pin = ctx.property.gisPin.replace(/-/g, '');
      // MapWNC may not handle condo "C" suffix — strip to base 10 digits
      if (pin.includes('C')) {
        pin = pin.slice(0, 10);
      }

      const pinInput = page.locator('input[type="text"], input[placeholder*="PIN"]').first();
      const inputVisible = await pinInput.isVisible({ timeout: 10_000 }).catch(() => false);
      if (!inputVisible) {
        // Try any visible text input
        const fallbackInput = page.locator('input').first();
        await fallbackInput.fill(pin).catch(() => {});
      } else {
        await pinInput.fill(pin);
      }
      await page.waitForTimeout(1_000);

      // Step 4: Click Calculate
      const calcBtn = page.locator('button:has-text("Calculate"), input[type="submit"]').first();
      if ((await calcBtn.count()) > 0) {
        await calcBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Waiting for slope results…' });

      // Step 5: Wait for results
      try {
        await page.waitForFunction(
          () => {
            const body = document.body?.textContent ?? '';
            const hasSlope = body.includes('Slope') && body.includes('%');
            const hasTable = !!document.querySelector('table, .results, #results, [class*="result"]');
            return hasSlope || hasTable;
          },
          { timeout: 15_000 },
        );
      } catch {
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
      }

      // Step 6: Extra render buffer
      await page.waitForTimeout(3_000);

      // Step 7: Capture PDF
      const bytes = Buffer.from(await page.pdf(pdfOptions()));

      const filename = `slope-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'Slope calculation (PDF)',
        filename,
        contentType: 'application/pdf',
        bytes,
        sourceUrl: SLOPE_URL,
      });

      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, filename);
      await writeFile(path, bytes);

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: path });
      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'Slope calculation (PDF)', contentType: 'application/pdf' }],
        data: { artifactId: artifact.id, artifactSha256: artifact.sha256, pinUsed: pin },
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
