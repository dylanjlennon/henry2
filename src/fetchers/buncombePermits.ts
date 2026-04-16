/**
 * buncombePermits — fetches Buncombe County building permits from Accela.
 *
 * Navigates to the Accela portal, enters the GIS PIN in the parcel search
 * field, submits, then generates a PDF of the results page.
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

      // Scroll down to trigger any lazy-loaded result content
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
