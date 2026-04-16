/**
 * deed — retrieves the recorded deed from Buncombe Register of Deeds.
 *
 * Uses the book/page already present in CanonicalProperty (populated by the
 * resolver from the parcel GIS record). Steps:
 *   1. Seed session in Indexed Records mode
 *   2. Switch to Book/Page search, fill form, submit
 *   3. Click result row → DocumentDetails page
 *   4. Click "N pages" link → image viewer
 *   5. Download via "Save Document as PDF" button (fall back to page.pdf())
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, pdfOptions, downloadToBuffer } from '../lib/browser.js';

const SEED_URL =
  'https://registerofdeeds.buncombecounty.org/External/LandRecords/protected/v4/SrchName.aspx?ModuleSelected=True';

export const deedFetcher: Fetcher = {
  id: 'deed',
  name: 'Deed (Register of Deeds)',
  counties: ['buncombe'],
  estimatedMs: 45_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    if (!ctx.property.deed) {
      ctx.onProgress?.({ fetcher: this.id, status: 'skipped', message: 'No deed book/page on record' });
      return { fetcher: this.id, status: 'skipped', files: [], error: 'No deed book/page', durationMs: Date.now() - t0 };
    }

    const { book, page: pg } = ctx.property.deed;
    // Cott Systems requires numbers without leading zeros
    const cleanBook = book.replace(/^0+/, '') || '0';
    const cleanPage = pg.replace(/^0+/, '') || '0';

    if (cleanBook === '0' || cleanPage === '0') {
      return { fetcher: this.id, status: 'skipped', files: [], error: 'Invalid deed book/page (zero)', durationMs: Date.now() - t0 };
    }

    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
      const page = await context.newPage();

      // Step 1: seed session
      await page.goto(SEED_URL, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2_000);

      // Step 2: navigate to Book/Page search form
      const bpNavBtn = page.locator('#ctl00_NavMenuIdxRec_btnNav_IdxRec_BookPage_NEW');
      if ((await bpNavBtn.count()) > 0) {
        await Promise.all([
          page.waitForLoadState('networkidle').catch(() => {}),
          bpNavBtn.click(),
        ]);
        await page.waitForTimeout(2_000);
      } else {
        await page.goto(
          'https://registerofdeeds.buncombecounty.org/external/LandRecords/protected/v4/SrchBookPage.aspx',
          { waitUntil: 'networkidle', timeout: 30_000 },
        ).catch(() => {});
        await page.waitForTimeout(2_000);
      }

      // Set index type to ALL (works for deeds)
      const sel = page.locator('#ctl00_cphMain_tcMain_tpNewSearch_ucSrchBkPg_ddlIndexType');
      if ((await sel.count()) > 0) {
        await sel.selectOption({ value: 'ALL' }).catch(() => {});
        await page.waitForTimeout(500);
      }

      const bk = page.locator('#ctl00_cphMain_tcMain_tpNewSearch_ucSrchBkPg_txtBookNumber');
      if ((await bk.count()) > 0) { await bk.fill(cleanBook); await page.waitForTimeout(300); }

      const pp = page.locator('#ctl00_cphMain_tcMain_tpNewSearch_ucSrchBkPg_txtPageNumber');
      if ((await pp.count()) > 0) { await pp.fill(cleanPage); await page.waitForTimeout(300); }

      const btn = page.locator('#ctl00_cphMain_tcMain_tpNewSearch_ucSrchBkPg_btnSearch');
      if ((await btn.count()) > 0) {
        await Promise.all([
          page.waitForLoadState('networkidle').catch(() => {}),
          btn.click(),
        ]);
        await page.waitForTimeout(5_000);
      }

      // Check for no-results
      const html = await page.content();
      if (html.includes('returned 0 results') || html.includes('No records found')) {
        return { fetcher: this.id, status: 'skipped', files: [], error: `No deed at Book ${book} Page ${pg}`, durationMs: Date.now() - t0 };
      }

      // Step 3: click result row
      const bookPageText = `${cleanBook} / ${cleanPage}`;
      const resultLink = page.locator(`a:has-text("${bookPageText}")`).first();
      if ((await resultLink.count()) > 0) {
        await Promise.all([
          page.waitForLoadState('networkidle').catch(() => {}),
          resultLink.click(),
        ]);
        await page.waitForTimeout(5_000);
      }

      // Step 4: click "N pages" link to open image viewer
      const pagesLink = page.locator('a:has-text("pages"), a:has-text("page")').first();
      if ((await pagesLink.count()) > 0) {
        await pagesLink.click();
        await page.waitForTimeout(8_000);
        await page.waitForLoadState('networkidle').catch(() => {});
      }

      // Step 5: download via "Save Document as PDF" or fall back to page.pdf()
      let bytes: Buffer;
      const saveBtn = page.locator('input[value="Save Document as PDF"]').first();
      if ((await saveBtn.count()) > 0) {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
          saveBtn.click(),
        ]);
        if (download) {
          bytes = await downloadToBuffer(download);
        } else {
          bytes = Buffer.from(await page.pdf(pdfOptions()));
        }
      } else {
        bytes = Buffer.from(await page.pdf(pdfOptions()));
      }

      const filename = `deed-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'Deed (PDF)',
        filename,
        contentType: 'application/pdf',
        bytes,
        sourceUrl: `https://registerofdeeds.buncombecounty.org/ Book:${book} Page:${pg}`,
      });

      await mkdir(ctx.outDir, { recursive: true });
      const path = join(ctx.outDir, filename);
      await writeFile(path, bytes);

      ctx.onProgress?.({ fetcher: this.id, status: 'completed', file: path });
      return {
        fetcher: this.id,
        status: 'completed',
        files: [{ path, label: 'Deed (PDF)', contentType: 'application/pdf' }],
        data: { deedBook: book, deedPage: pg, artifactId: artifact.id, artifactSha256: artifact.sha256 },
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
