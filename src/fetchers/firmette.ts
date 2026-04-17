/**
 * firmette — downloads the FEMA FIRMette flood map PDF.
 *
 * Two-phase approach:
 *   1. Query NFHL REST API at the property centroid to find the FIRM panel ID.
 *   2. Download the FIRMette.
 *
 * FLOW:
 *
 *   Phase 1 — NFHL REST lookup (no browser):
 *     Query layers 3, 0, 1, 2, 4, 5, 28, 29 of the NFHL MapServer with the
 *     property centroid (lon/lat). Extract FIRM_PAN or FIRM_ID field.
 *     Build the firmette URL: msc.fema.gov/portal/downloadFirmette?efsc=...&type=PDF
 *
 *   PATH A — Direct HTTP PDF fetch:
 *     Try fetching the firmette URL directly. If FEMA serves the PDF inline
 *     (content-type: application/pdf), save it. Fast path (~5s).
 *
 *   PATH B — Browser: Dynamic FIRMette map (preferred when Phase 1 succeeds):
 *     1. Navigate to msc.fema.gov/portal/downloadFirmette?efsc=...
 *     2. Wait 15s for the page to load and generate the map.
 *     3. Look for a "Dynamic FIRMette" link or button:
 *          CSS: a[href*="dynamic"], a:has-text("Dynamic"), #btnDynamicFirmette,
 *               a:has-text("Interactive"), a[href*="FIRMette"]
 *        If found, navigate to it (or click it) and print that page as PDF.
 *        The dynamic map page renders the flood zone graphically — this is what
 *        the user wants to see.
 *     4. If no dynamic link, try to grab the embedded map image directly:
 *          CSS: img[src*="map"], img[src*="firm"], embed[src], object[data], iframe[src]
 *        Embed it in a PDF page.
 *     5. If still nothing useful, capture the downloadFirmette page as PDF.
 *        At minimum this contains the flood zone designation text.
 *
 *   PATH C — FEMA MSC portal address search fallback (when Phase 1 fails):
 *     1. Navigate to msc.fema.gov/portal/home.
 *     2. Fill #txtAddressSearch with the property address and click #addressLocate.
 *     3. Wait 15s (FEMA portal is a heavy SPA).
 *     4. Look for FIRMette / Dynamic FIRMette link and follow same steps as PATH B.
 *
 * WHAT CAN BREAK:
 *   - NFHL REST service moves/changes field names (FIRM_PAN → different attribute)
 *   - #btnDynamicFirmette ID changes between FEMA portal releases
 *   - Dynamic FIRMette page requires JS to render the map; headless capture may be blank
 *   - msc.fema.gov portal structure changes — the search widget uses #txtAddressSearch/#addressLocate
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Fetcher, FetcherContext, FetcherResult } from '../types.js';
import { launchBrowser, downloadToBuffer } from '../lib/browser.js';
import { femaFirmetteUrl } from '../sources/buncombe.js';

const NFHL_BASE = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const PANEL_LAYERS = [3, 0, 1, 2, 4, 5, 28, 29];

export const firmetteFetcher: Fetcher = {
  id: 'firmette',
  name: 'FEMA FIRMette flood map (PDF)',
  counties: ['buncombe'],
  estimatedMs: 90_000,
  needsBrowser: true,

  async run(ctx: FetcherContext): Promise<FetcherResult> {
    const t0 = Date.now();
    ctx.onProgress?.({ fetcher: this.id, status: 'started' });

    // Phase 1: find FIRM panel via REST
    let firmetteUrl: string | null = null;
    if (ctx.property.centroid) {
      firmetteUrl = await findFirmPanel(ctx.property.centroid.lon, ctx.property.centroid.lat);
    }

    // PATH A: direct HTTP fetch (fastest, no browser needed)
    if (firmetteUrl) {
      ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Trying direct PDF fetch…' });
      try {
        const resp = await fetch(firmetteUrl, {
          signal: AbortSignal.timeout(30_000),
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Henry/2)' },
        });
        if (resp.ok && (resp.headers.get('content-type') ?? '').includes('application/pdf')) {
          const bytes = Buffer.from(await resp.arrayBuffer());
          if (bytes.byteLength > 10_000) {
            return await saveAndReturn(ctx, bytes, firmetteUrl, t0);
          }
        }
      } catch { /* fall through to browser */ }
    }

    // PATH B / C: browser-based capture
    const browser = await launchBrowser(ctx.signal);
    try {
      const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
      const page = await context.newPage();

      // Track any intercepted PDF bytes from network responses
      const intercepted: { pdf: Buffer | null } = { pdf: null };
      page.on('response', async (resp) => {
        try {
          if ((resp.headers()['content-type'] ?? '').includes('application/pdf') && !intercepted.pdf) {
            intercepted.pdf = Buffer.from(await resp.body());
          }
        } catch { /* ignore */ }
      });

      let bytes: Buffer | null = null;

      // PATH B: navigate to the FIRMette page and look for Dynamic FIRMette link
      if (firmetteUrl) {
        ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Loading FIRMette page…' });
        const [dl] = await Promise.all([
          page.waitForEvent('download', { timeout: 30_000 }).catch(() => null),
          page.goto(firmetteUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {}),
        ]);
        if (dl) bytes = await downloadToBuffer(dl);
        if (bytes && bytes.byteLength > 10_000) {
          return await saveAndReturn(ctx, bytes, firmetteUrl, t0);
        }

        // Wait for page to fully render (map generation is async on FEMA portal)
        await page.waitForTimeout(15_000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

        // Check for intercepted PDF
        if (intercepted.pdf && intercepted.pdf.byteLength > 10_000) {
          return await saveAndReturn(ctx, intercepted.pdf, firmetteUrl, t0);
        }

        // Look for Dynamic FIRMette link — this renders the full flood map with imagery
        const dynamicSelectors = [
          '#btnDynamicFirmette',
          'a[href*="dynamic"]',
          'a:has-text("Dynamic FIRMette")',
          'a:has-text("Dynamic")',
          'a:has-text("Interactive")',
          'button:has-text("Dynamic")',
        ];
        for (const sel of dynamicSelectors) {
          const link = page.locator(sel).first();
          const visible = await link.isVisible({ timeout: 3_000 }).catch(() => false);
          if (!visible) continue;

          ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Found dynamic FIRMette link, loading…' });
          const href = await link.getAttribute('href').catch(() => null);
          const targetUrl = href
            ? (href.startsWith('http') ? href : `https://msc.fema.gov${href}`)
            : null;

          if (targetUrl) {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
          } else {
            await link.click().catch(() => {});
          }
          // Dynamic FIRMette is a map SPA — give it time to render tiles
          await page.waitForTimeout(15_000);
          await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
          await page.waitForTimeout(5_000);

          // Capture via screenshot → embed in PDF (avoids print-mode map shift)
          const screenshot = Buffer.from(await page.screenshot({ type: 'png', fullPage: false }));
          const htmlPage = await browser.newPage();
          await htmlPage.setContent(
            `<html><body style="margin:0;padding:0;background:#fff">` +
            `<img src="data:image/png;base64,${screenshot.toString('base64')}" style="width:100%;height:auto"/>` +
            `</body></html>`,
            { waitUntil: 'load' },
          );
          bytes = Buffer.from(await htmlPage.pdf({ format: 'Letter', landscape: true, printBackground: true }));
          await htmlPage.close();
          if (bytes.byteLength > 10_000) break;
        }

        // If no dynamic link worked, check for embedded map image
        if (!bytes || bytes.byteLength <= 10_000) {
          const embedSrc = await page.locator('img[src*="map"], img[src*="firm"], embed[src], object[data], iframe[src]')
            .first().getAttribute('src').catch(() => null);
          if (embedSrc) {
            const fullUrl = embedSrc.startsWith('http') ? embedSrc : `https://msc.fema.gov${embedSrc}`;
            try {
              const r = await fetch(fullUrl, { signal: AbortSignal.timeout(20_000) });
              if (r.ok) {
                const ct = r.headers.get('content-type') ?? '';
                if (ct.includes('application/pdf')) {
                  bytes = Buffer.from(await r.arrayBuffer());
                } else if (ct.includes('image/')) {
                  // Wrap image in a PDF page
                  const imgBuf = Buffer.from(await r.arrayBuffer());
                  const imgPage = await browser.newPage();
                  await imgPage.setContent(
                    `<html><body style="margin:0;padding:0"><img src="data:${ct};base64,${imgBuf.toString('base64')}" style="width:100%;height:auto"/></body></html>`,
                    { waitUntil: 'load' },
                  );
                  bytes = Buffer.from(await imgPage.pdf({ format: 'Letter', printBackground: true }));
                  await imgPage.close();
                }
              }
            } catch { /* ignore */ }
          }
        }

        // Capture whatever is on the page if we still have nothing
        if (!bytes || bytes.byteLength <= 10_000) {
          bytes = Buffer.from(await page.pdf({
            format: 'Letter',
            printBackground: true,
            margin: { top: '0.25in', bottom: '0.25in', left: '0.25in', right: '0.25in' },
          }));
        }
      }

      // PATH C: FEMA MSC portal address search (when Phase 1 / REST lookup failed)
      if (!bytes || bytes.byteLength <= 10_000) {
        const address = ctx.property.address ?? '';
        ctx.onProgress?.({ fetcher: this.id, status: 'progress', message: 'Searching FEMA portal by address…' });
        await page.goto('https://msc.fema.gov/portal/home', { waitUntil: 'load', timeout: 60_000 }).catch(() => {});
        await page.waitForTimeout(3_000);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

        const searchInput = page.locator('#txtAddressSearch');
        const visible = await searchInput.isVisible({ timeout: 15_000 }).catch(() => false);
        if (visible && address) {
          await searchInput.fill(address);
          const searchBtn = page.locator('#addressLocate');
          if ((await searchBtn.count()) > 0) await searchBtn.click();
          else await page.keyboard.press('Enter');

          await page.waitForTimeout(15_000);
          await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

          // Look for any FIRMette link
          const firmSelectors = [
            'a[href*="downloadFirmette"]',
            'a:has-text("FIRMette")',
            '#btnDynamicFirmette',
            'button:has-text("FIRMette")',
          ];
          for (const fsel of firmSelectors) {
            const link = page.locator(fsel).first();
            if (!(await link.isVisible({ timeout: 5_000 }).catch(() => false))) continue;
            const href = await link.getAttribute('href').catch(() => null);
            if (href) {
              const fullUrl = href.startsWith('http') ? href : `https://msc.fema.gov${href}`;
              await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
              await page.waitForTimeout(15_000);
              await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
            } else {
              await link.click().catch(() => {});
              await page.waitForTimeout(10_000);
            }
            if (intercepted.pdf && intercepted.pdf.byteLength > 10_000) {
              bytes = intercepted.pdf;
              break;
            }
          }
        }

        if (!bytes || bytes.byteLength <= 10_000) {
          bytes = Buffer.from(await page.pdf({
            format: 'Letter',
            printBackground: true,
            margin: { top: '0.25in', bottom: '0.25in', left: '0.25in', right: '0.25in' },
          }));
        }
      }

      return await saveAndReturn(ctx, bytes!, firmetteUrl ?? 'https://msc.fema.gov/portal/home', t0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.onProgress?.({ fetcher: this.id, status: 'failed', error: msg });
      return { fetcher: this.id, status: 'failed', files: [], error: msg, durationMs: Date.now() - t0 };
    } finally {
      await browser.close();
    }
  },
};

async function saveAndReturn(
  ctx: FetcherContext,
  bytes: Buffer,
  sourceUrl: string,
  t0: number,
): Promise<FetcherResult> {
  const filename = `firmette-${ctx.property.gisPin}.pdf`;
  const artifact = await ctx.run.recorder.putArtifact({
    fetcherCallId: ctx.run.fetcherCallId,
    label: 'FEMA FIRMette (PDF)',
    filename,
    contentType: 'application/pdf',
    bytes,
    sourceUrl,
  });
  await mkdir(ctx.outDir, { recursive: true });
  const path = join(ctx.outDir, filename);
  await writeFile(path, bytes);
  ctx.onProgress?.({ fetcher: 'firmette', status: 'completed', file: path });
  return {
    fetcher: 'firmette',
    status: 'completed',
    files: [{ path, label: 'FEMA FIRMette (PDF)', contentType: 'application/pdf' }],
    data: { panel: extractPanel(sourceUrl), artifactId: artifact.id, artifactSha256: artifact.sha256 },
    durationMs: Date.now() - t0,
  };
}

/** Query NFHL REST for FIRM panel at a lon/lat. Returns firmette URL or null. */
async function findFirmPanel(lon: number, lat: number): Promise<string | null> {
  const baseQuery = new URLSearchParams({
    geometry: `${lon},${lat}`,
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'false',
    f: 'json',
  });
  for (const layerId of PANEL_LAYERS) {
    const url = `${NFHL_BASE}/${layerId}/query?${baseQuery}`;
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) continue;
      const data = await resp.json().catch(() => ({}));
      if (data.error) continue;
      for (const feat of (data.features ?? [])) {
        const attrs = feat.attributes ?? {};
        const raw = attrs.FIRM_PAN ?? attrs.FIRM_ID ?? attrs.PANEL ?? attrs.FLD_AR_ID;
        const panel = raw ? String(raw).trim() : null;
        if (panel && panel.length >= 10 && panel !== 'null') {
          return femaFirmetteUrl(panel);
        }
      }
    } catch { /* try next layer */ }
  }
  return null;
}

function extractPanel(url: string): string | null {
  const m = url.match(/efsc=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
