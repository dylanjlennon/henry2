/**
 * simplicityProperty — fetches City of Asheville property details from SimpliCity.
 *
 * TARGET URL:
 *   https://simplicity.ashevillenc.gov/permits/search?search={displayPin}
 *   (Built by ashevillePermitsUrl() in src/sources/buncombe.ts)
 *
 * NOTE: This fetcher uses a PIN deep-link (not address search like ashevillePermits).
 * The PIN in the query string tells SimpliCity's React app to pre-filter results
 * to this exact parcel. Properties outside Asheville city limits return no results.
 *
 * FLOW:
 *   1. Navigate to the PIN search URL (networkidle, 60s).
 *   2. Wait 2s + dismiss cookie/terms modal (button text: "Accept").
 *   3. Check page HTML for "No results" / "not found" → skip if outside Asheville.
 *   4. Find the first property result link:
 *        CSS: a[href*="property"]
 *      (SimpliCity result items link to /property/{id} — first one is the match)
 *   5. Click the property link → wait networkidle + 5s for the React detail view to load.
 *   6. Scroll to bottom (2s) then back to top (1s) to ensure all lazy sections render.
 *   7. Capture page.pdf() → PDF 1: simplicity-property-{gisPin}.pdf
 *      This is the full property card: ownership, zoning, land use, valuations.
 *
 *   OPTIONAL PDF 2 (associated address):
 *   8. Look for the "Associated Address" link on the property detail page:
 *        CSS: a[href*="/address?"], a:has-text("Associated Address")
 *      Present only for properties with an address record in the city system.
 *   9. If found: click → wait networkidle + 5s → scroll → capture PDF 2:
 *        simplicity-address-{gisPin}.pdf
 *      This is the city address record: address history, service connections, notes.
 *
 * WHAT CAN BREAK:
 *   - "No results" HTML check is fragile if SimpliCity changes that copy
 *   - a[href*="property"] selector hits any link with "property" in the href;
 *     if navigation links change, could click the wrong thing
 *   - 5s post-click wait is a guess for React render time; slow city servers need more
 *   - Associated address link may not exist for rural-style lots in the city boundary
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, pdfOptions, dismissModal } from '../lib/browser.js';
import { ashevillePermitsUrl } from '../sources/buncombe.js';

export const simplicityPropertyFetcher: Fetcher = {
  id: 'simplicity-property',
  name: 'SimpliCity property details (Asheville)',
  counties: ['buncombe'],
  estimatedMs: 45_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const page = await context.newPage();
      const url = ashevillePermitsUrl(ctx.property.pin);

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForTimeout(2_000);
      await dismissModal(page, ['Accept']);

      const content = await page.content();
      if (content.includes('No results') || content.includes('not found')) {
        ctx.onProgress?.({ fetcher: this.id, status: 'skipped', message: 'Property not in Asheville (no results)' });
        return { fetcher: this.id, status: 'skipped', files: [], error: 'Not in Asheville city limits', durationMs: Date.now() - t0 };
      }

      // Click first property link in results
      const propertyLink = page.locator('a[href*="property"]').first();
      if ((await propertyLink.count()) === 0) {
        ctx.onProgress?.({ fetcher: this.id, status: 'skipped', message: 'No property link in SimpliCity results' });
        return { fetcher: this.id, status: 'skipped', files: [], error: 'No property link found', durationMs: Date.now() - t0 };
      }

      await propertyLink.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(5_000);

      // Scroll to ensure full render
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2_000);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(1_000);

      const files: import('../types.js').ProducedFile[] = [];
      await mkdir(ctx.outDir, { recursive: true });

      // PDF 1: property details
      const propBytes = Buffer.from(await page.pdf(pdfOptions()));
      const propFilename = `simplicity-property-${ctx.property.gisPin}.pdf`;
      await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'SimpliCity property details (PDF)',
        filename: propFilename,
        contentType: 'application/pdf',
        bytes: propBytes,
        sourceUrl: page.url(),
      });
      const propPath = join(ctx.outDir, propFilename);
      await writeFile(propPath, propBytes);
      files.push({ path: propPath, label: 'SimpliCity property details (PDF)', contentType: 'application/pdf' });

      // PDF 2: associated address page (if present)
      const addressLink = page.locator('a[href*="/address?"], a:has-text("Associated Address")').first();
      if ((await addressLink.count()) > 0) {
        await addressLink.click();
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(5_000);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(2_000);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(1_000);

        const addrBytes = Buffer.from(await page.pdf(pdfOptions()));
        const addrFilename = `simplicity-address-${ctx.property.gisPin}.pdf`;
        await ctx.run.recorder.putArtifact({
          fetcherCallId: ctx.run.fetcherCallId,
          label: 'SimpliCity address details (PDF)',
          filename: addrFilename,
          contentType: 'application/pdf',
          bytes: addrBytes,
          sourceUrl: page.url(),
        });
        const addrPath = join(ctx.outDir, addrFilename);
        await writeFile(addrPath, addrBytes);
        files.push({ path: addrPath, label: 'SimpliCity address details (PDF)', contentType: 'application/pdf' });
      }

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: files[0].path });
      return { fetcher: this.id, status: 'completed', files, durationMs: Date.now() - t0 };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.onProgress?.({ fetcher: this.id, status: 'failed', error: msg });
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    } finally {
      await browser.close();
    }
  },
};
