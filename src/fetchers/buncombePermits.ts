/**
 * buncombePermits — fetches Buncombe County building permits from Accela.
 *
 * TARGET URL:
 *   https://aca-prod.accela.com/BUNCOMBECONC/Cap/CapHome.aspx?module=Building&...
 *   (The full URL is built by accelaPermitsUrl() in src/sources/buncombe.ts)
 *
 * FLOW:
 *   1. Navigate to Accela "Building" tab landing page (waitUntil: networkidle, 90s).
 *      The long timeout is needed — Accela is a legacy .NET app and loads slowly.
 *   2. Wait 3s for the .NET WebForms page to fully initialize its PostBack handlers.
 *   3. Find the Parcel Number input:
 *        CSS: #ctl00_PlaceHolderMain_generalSearchForm_txtGSParcelNo
 *        (ASP.NET server-generated ID — stable unless county upgrades Accela version)
 *      Fill with the 15-digit GIS PIN (no dashes).
 *   4. Wait 1.5s then press Enter. The form does a full PostBack (page reload).
 *   5. Wait for networkidle again (catches the PostBack reload), then 3s buffer.
 *   6. Scroll pattern: 1000px down → bottom → top, with waits between each.
 *      Accela lazy-loads permit cards via JavaScript as the user scrolls.
 *      Without this, the PDF captures only the first visible batch.
 *   7. Capture the full results page as PDF (page.pdf via pdfOptions()).
 *
 * WHAT CAN BREAK:
 *   - Accela form ID changes if county upgrades (throw tells you immediately)
 *   - networkidle can time out on slow county days — the .catch(() => {}) swallows it
 *   - Scroll amounts are guesses; if a property has >20 permits, last batch may be cut off
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, pdfOptions } from '../lib/browser.js';
import { accelaPermitsUrl } from '../sources/buncombe.js';

export const buncombePermitsFetcher: Fetcher = {
  id: 'buncombe-permits',
  name: 'Buncombe County permits (Accela)',
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

      await page.goto(accelaPermitsUrl(), { waitUntil: 'networkidle', timeout: 90_000 });
      await page.waitForTimeout(3_000);

      const pinInput = page.locator('#ctl00_PlaceHolderMain_generalSearchForm_txtGSParcelNo').first();
      if ((await pinInput.count()) === 0) throw new Error('Could not find Parcel Number input in Accela');

      await pinInput.fill(ctx.property.gisPin);
      await page.waitForTimeout(1_500);
      await pinInput.press('Enter');

      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(3_000);

      // Scroll to trigger lazy-loaded permit cards. Accela renders results
      // in batches as you scroll — skipping this leaves the bottom ~30% blank.
      // Pattern: partial scroll → full bottom → back to top (for clean PDF capture).
      await page.evaluate(() => window.scrollBy(0, 1_000));
      await page.waitForTimeout(2_000);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(3_000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1_000);

      const bytes = Buffer.from(await page.pdf(pdfOptions()));

      const filename = `buncombe-permits-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'Buncombe County permits (PDF)',
        filename,
        contentType: 'application/pdf',
        bytes,
        sourceUrl: accelaPermitsUrl(),
      });

      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, filename);
      await writeFile(path, bytes);

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: path });
      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'Buncombe County permits (PDF)', contentType: 'application/pdf' }],
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
