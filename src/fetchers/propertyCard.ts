/**
 * propertyCard — fetches the Spatialest Property Record Card (PRC) as a PDF.
 *
 * Navigates directly to the deep-link URL for the PIN, waits for the
 * interactive card to render, then calls page.pdf().
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, pdfOptions, dismissModal } from '../lib/browser.js';

export const propertyCardFetcher: Fetcher = {
  id: 'property-card',
  name: 'Property Record Card (Spatialest)',
  counties: ['buncombe'],
  estimatedMs: 25_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    const browser = await launchBrowser(ctx.signal);
    try {
      const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
      const url = `https://prc-buncombe.spatialest.com/#/property/${ctx.property.gisPin}`;

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
      await dismissModal(page);
      // Give the React app a moment to finish rendering after network idle
      await page.waitForTimeout(3_000);
      await dismissModal(page);

      const bytes = Buffer.from(await page.pdf(pdfOptions()));

      const filename = `property-card-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'Property Record Card (PDF)',
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
        files: [{ path, label: 'Property Record Card (PDF)', contentType: 'application/pdf' }],
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
