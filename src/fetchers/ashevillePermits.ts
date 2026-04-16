/**
 * ashevillePermits — fetches Asheville city permit history from SimpliCity.
 *
 * Searches by address (not PIN), navigates to the Permits tab, downloads a
 * CSV if available, and captures the permit list as a PDF.
 *
 * Skips gracefully if no address is available or the property isn't in Asheville.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, pdfOptions, dismissModal, downloadToBuffer } from '../lib/browser.js';

export const ashevillePermitsFetcher: Fetcher = {
  id: 'asheville-permits',
  name: 'Asheville city permits (SimpliCity)',
  counties: ['buncombe'],
  estimatedMs: 60_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    if (!ctx.property.address) {
      ctx.onProgress?.({ fetcher: this.id, status: 'skipped', message: 'No address available' });
      return { fetcher: this.id, status: 'skipped', files: [], error: 'No address', durationMs: Date.now() - t0 };
    }

    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
      const page = await context.newPage();

      await page.goto('https://simplicity.ashevillenc.gov/permits/search', { waitUntil: 'networkidle', timeout: 60_000 });
      await page.waitForTimeout(2_000);
      await dismissModal(page, ['Accept']);

      // Type address into search box
      const searchBox = page.locator('#searchBox, input[placeholder*="Search"]').first();
      await searchBox.fill(ctx.property.address);
      await page.waitForTimeout(2_000);

      // Wait for autocomplete dropdown and pick first matching option
      const firstPart = ctx.property.address.split(',')[0].trim();
      try {
        await page.waitForSelector('[role="option"], .dropdown-item, .search-result', { timeout: 5_000 });
        const option = page.locator(`
          [role="option"]:has-text("${firstPart}"),
          .dropdown-item:has-text("${firstPart}"),
          .search-result:has-text("${firstPart}"),
          li:has-text("${firstPart}")
        `).first();

        if ((await option.count()) > 0) {
          await option.click();
          await page.waitForLoadState('networkidle');
          await page.waitForTimeout(3_000);
        } else {
          throw new Error('no dropdown option');
        }
      } catch {
        // Try pressing Enter or clicking Search button as fallback
        const searchBtn = page.locator('button[type="submit"]:has-text("Search"), button:has-text("Search")').first();
        if ((await searchBtn.count()) > 0) {
          await searchBtn.click();
        } else {
          await searchBox.press('Enter');
        }
        await page.waitForLoadState('networkidle');
        await page.waitForTimeout(2_000);
      }

      // Check we landed on a property/address page
      const content = await page.content();
      if (content.includes('No results') || content.includes('not found')) {
        ctx.onProgress?.({ fetcher: this.id, status: 'skipped', message: 'Property not in Asheville' });
        return { fetcher: this.id, status: 'skipped', files: [], error: 'Not in Asheville', durationMs: Date.now() - t0 };
      }

      // Navigate to Permits tab
      await page.waitForTimeout(1_000);
      const permitsLink = page.locator('a:has-text("Permits"), button:has-text("Permits")').first();
      if ((await permitsLink.count()) === 0) {
        ctx.onProgress?.({ fetcher: this.id, status: 'skipped', message: 'No Permits tab on property page' });
        return { fetcher: this.id, status: 'skipped', files: [], error: 'No Permits tab', durationMs: Date.now() - t0 };
      }

      await permitsLink.click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2_000);

      const files: import('../types.js').ProducedFile[] = [];
      await mkdir(ctx.outDir, { recursive: true });

      // Download CSV if available
      try {
        const dlBtn = page.locator('button:has-text("Download"), a:has-text("Download")').first();
        if ((await dlBtn.count()) > 0) {
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 30_000 }),
            dlBtn.click(),
          ]);
          const csvBytes = await downloadToBuffer(download);
          const csvFilename = `asheville-permits-${ctx.property.gisPin}.csv`;
          await ctx.run.recorder.putArtifact({
            fetcherCallId: ctx.run.fetcherCallId,
            label: 'Asheville permits (CSV)',
            filename: csvFilename,
            contentType: 'text/csv',
            bytes: csvBytes,
            sourceUrl: page.url(),
          });
          const csvPath = join(ctx.outDir, csvFilename);
          await writeFile(csvPath, csvBytes);
          files.push({ path: csvPath, label: 'Asheville permits (CSV)', contentType: 'text/csv' });
        }
      } catch { /* no CSV available */ }

      // Expand all accordion rows
      const arrows = await page.locator('button[aria-expanded="false"]').all();
      for (const arrow of arrows) {
        try { await arrow.click(); await page.waitForTimeout(300); } catch { /* ignore */ }
      }
      await page.waitForTimeout(1_000);

      // Capture full permit list as PDF
      const pdfBytes = Buffer.from(await page.pdf(pdfOptions()));
      const pdfFilename = `asheville-permits-${ctx.property.gisPin}.pdf`;
      await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'Asheville permits (PDF)',
        filename: pdfFilename,
        contentType: 'application/pdf',
        bytes: pdfBytes,
        sourceUrl: page.url(),
      });
      const pdfPath = join(ctx.outDir, pdfFilename);
      await writeFile(pdfPath, pdfBytes);
      files.push({ path: pdfPath, label: 'Asheville permits (PDF)', contentType: 'application/pdf' });

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: pdfPath });
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
