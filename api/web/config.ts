/**
 * GET /api/web/config
 *
 * Returns public runtime config for the web UI.
 * Only exposes keys that are safe to send to the browser.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.status(200).json({
    googlePlacesKey: process.env.GOOGLE_PLACES_API_KEY ?? '',
  });
}
