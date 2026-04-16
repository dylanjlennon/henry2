/**
 * taxBill — downloads the Buncombe County tax bill PDF.
 *
 * Navigates to the Parcel Details page, clicks the "Print Bill" download
 * button, and captures the downloaded PDF.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, dismissModal, downloadToBuffer } from '../lib/browser.js';
import { taxBillUrl } from '../sources/buncombe.js';

export const taxBillFetcher: Fetcher = {
  id: 'tax-bill',
  name: 'Tax bill (Buncombe County)',
  counties: ['buncombe'],
  estimatedMs: 30_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, acceptDownloads: true });
      const page = await context.newPage();
      const url = taxBillUrl(ctx.property.gisPin);

      await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
      await dismissModal(page, ['I understand', 'Accept']);
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(2_000);

      // Scroll to trigger any lazy-loaded bill section
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1_500);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(500);

      const downloadButton = await findFirst(page, [
        'a:has-text("Print Bill")',
        'button:has-text("Print Bill")',
        'a:has-text("View Bill")',
        'a[href*="Bill/Print"]',
        'a[href*="bill"]',
        'a[href*="pdf"]',
        '.btn:has-text("Bill")',
      ]);

      if (!downloadButton) {
        throw new Error('Could not find Print Bill / PDF button on tax page');
      }

      // The button may be hidden (off-screen) — extract the href and navigate
      // directly rather than clicking, which avoids the visibility requirement.
      const href = await downloadButton.getAttribute('href').catch(() => null);
      let bytes: Buffer;

      if (href) {
        const billUrl = href.startsWith('http')
          ? href
          : `https://tax.buncombenc.gov${href}`;

        // Use context.request.get() to download the PDF with the current session
        // cookies but bypassing Chrome's PDF viewer, which intercepts page.goto()
        // and prevents Playwright from capturing the response bytes.
        const resp = await context.request.get(billUrl, { timeout: 45_000 }).catch(() => null);
        if (resp && resp.ok() && (resp.headers()['content-type'] ?? '').includes('application/pdf')) {
          bytes = Buffer.from(await resp.body());
        } else {
          // Fallback: navigate and wait for download event (e.g. if URL redirects
          // through a session check before serving the PDF)
          const [download] = await Promise.all([
            page.waitForEvent('download', { timeout: 45_000 }).catch(() => null),
            page.goto(billUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}),
          ]);
          await page.waitForTimeout(2_000);
          if (download) {
            bytes = await downloadToBuffer(download);
          } else {
            bytes = Buffer.from(await page.pdf({ format: 'Letter', printBackground: true }));
          }
        }
      } else {
        // No href — try scrolling into view and force-clicking
        await downloadButton.scrollIntoViewIfNeeded().catch(() => {});
        await page.waitForTimeout(500);
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 45_000 }).catch(() => null),
          downloadButton.click({ force: true }),
        ]);
        if (download) {
          bytes = await downloadToBuffer(download);
        } else {
          bytes = Buffer.from(await page.pdf({ format: 'Letter', printBackground: true }));
        }
      }

      const filename = `tax-bill-${ctx.property.gisPin}.pdf`;
      const artifact = await ctx.run.recorder.putArtifact({
        fetcherCallId: ctx.run.fetcherCallId,
        label: 'Tax bill (PDF)',
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
        files: [{ path, label: 'Tax bill (PDF)', contentType: 'application/pdf' }],
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

async function findFirst(page: import('playwright-core').Page, selectors: string[]) {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) return el;
  }
  return null;
}
