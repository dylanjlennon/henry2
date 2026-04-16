/**
 * Shared Playwright browser launcher.
 *
 * On Vercel/Lambda: uses @sparticuz/chromium to get a headless Chromium binary.
 * Locally: falls back to a system Chrome install (CHROME_PATH env var or
 * well-known locations), because playwright-core ships without bundled browsers.
 */

import { chromium, type Browser, type Page } from 'playwright-core';

// Module-level singleton so concurrent browser launches share one download.
// The first call initiates the download; subsequent concurrent calls await the
// same promise instead of each racing to download and extract the 61 MB binary.
let _chromiumExePromise: Promise<string> | null = null;

async function getChromiumExecutablePath(): Promise<string> {
  if (!_chromiumExePromise) {
    const chr = (await import('@sparticuz/chromium-min')).default;
    const chromiumUrl =
      'https://github.com/Sparticuz/chromium/releases/download/v147.0.0/chromium-v147.0.0-pack.x64.tar';
    _chromiumExePromise = chr.executablePath(chromiumUrl);
  }
  return _chromiumExePromise;
}

/**
 * Launch a browser and wire up an optional AbortSignal so the fetcher's
 * per-fetcher timeout actually kills the browser (and unblocks the slot)
 * rather than letting it run until the Vercel function hard-limit.
 */
export async function launchBrowser(signal?: AbortSignal): Promise<Browser> {
  let browser: Browser;
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const chr = (await import('@sparticuz/chromium-min')).default;
    browser = await chromium.launch({
      args: chr.args,
      executablePath: await getChromiumExecutablePath(),
      headless: true,
    });
  } else {
    const executablePath = process.env.CHROME_PATH ?? guessLocalChromePath();
    browser = await chromium.launch({ headless: true, executablePath });
  }

  // When the per-fetcher abort signal fires (timeout), close the browser so
  // the concurrency slot is freed instead of hanging until the function dies.
  if (signal) {
    const onAbort = () => browser.close().catch(() => undefined);
    signal.addEventListener('abort', onAbort, { once: true });
    browser.on('disconnected', () => signal.removeEventListener('abort', onAbort));
  }

  return browser;
}

function guessLocalChromePath(): string | undefined {
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (process.platform === 'linux') {
    return '/usr/bin/google-chrome';
  }
  return undefined;
}

/** Strip hyphens from a display PIN to get the 15-digit GIS PIN. */
export function cleanPIN(pin: string): string {
  return pin.replace(/-/g, '');
}

/** Standard PDF options for Letter-sized output. */
export function pdfOptions() {
  return {
    format: 'Letter' as const,
    printBackground: true,
    margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
  };
}

/**
 * Dismiss a modal/dialog if any matching button is visible.
 * Swallows errors — caller should proceed regardless.
 */
export async function dismissModal(
  page: Page,
  texts = ['I understand', 'Accept', 'OK', 'Close', 'Agree'],
): Promise<void> {
  try {
    const sel = texts.map((t) => `button:has-text("${t}")`).join(', ');
    const btn = page.locator(sel).first();
    if ((await btn.count()) > 0) {
      await btn.click();
      await page.waitForTimeout(800);
    }
  } catch {
    /* no modal — ignore */
  }
}

/** Collect a Playwright Download object into a Buffer. */
export async function downloadToBuffer(download: import('playwright-core').Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
