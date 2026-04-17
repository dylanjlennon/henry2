/**
 * propertyCard — fetches the Spatialest Property Record Card (PRC) as a PDF.
 *
 * TARGET URL:
 *   https://prc-buncombe.spatialest.com/#/property/{gisPin}
 *   (15-digit GIS PIN, no dashes. Hard-coded here — no builder in buncombe.ts
 *   because there is no parameterized variation; the hash-route is the only form.)
 *
 * WHAT IT IS:
 *   Spatialest is the third-party property valuation platform Buncombe County uses.
 *   The PRC is the official tax assessor record: square footage, room count, year built,
 *   construction quality, assessed value history, land details, and sales history.
 *   This is a React single-page app (SPA) — the URL hash is the client-side route.
 *
 * FLOW:
 *   1. Navigate to the deep-link URL (waitUntil: networkidle, 60s).
 *      networkidle works here because Spatialest's data fetch is a single API call
 *      and the SPA idles cleanly after it resolves.
 *   2. dismissModal() — Spatialest sometimes shows a "Continue as Guest" overlay.
 *   3. Wait 3s extra render buffer. After networkidle, React still needs a render
 *      cycle or two to paint the property card sections from the fetched JSON.
 *      Without this wait, the PDF captures a partially-rendered card (e.g. blank
 *      valuation tables).
 *   4. dismissModal() again — a second modal can appear after the data loads
 *      (e.g. "Data may be subject to change" notice).
 *   5. page.pdf() → property-card-{gisPin}.pdf
 *
 * WHAT CAN BREAK:
 *   - URL structure (/#/property/{id}) is Spatialest's standard pattern and has been
 *     stable, but could change if county upgrades to a new Spatialest version
 *   - 3s wait may be insufficient on slow connections; increase to 5s if blank tables appear
 *   - dismissModal() looks for common modal close patterns — if Spatialest changes
 *     their modal markup, it silently skips (non-fatal; card still captures)
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
