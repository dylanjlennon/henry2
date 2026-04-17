# Henry — Developer Guide

Property research bot for Buncombe County, NC. Resolves any address or PIN → runs 12 parallel fetchers → delivers documents to Slack thread or web UI.

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env.local   # fill in required vars (see below)
npm run dev                   # vercel dev on :3000
npm test                      # unit tests (no creds needed)
npm run test:e2e              # hits live https://henry-slack.vercel.app
```

## Required env vars

| Var | Purpose |
|-----|---------|
| `DATABASE_URL` | Neon Postgres connection string |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob (auto-set when Blob store connected to project) |
| `SLACK_BOT_TOKEN` | `xoxb-...` bot token from api.slack.com |
| `SLACK_SIGNING_SECRET` | Request signature verification |
| `PUBLIC_BASE_URL` | Canonical URL, e.g. `https://henry-slack.vercel.app` |
| `ARTIFACT_BACKEND` | `vercel-blob` (prod) or `filesystem` (local dev) |
| `GOOGLE_PLACES_API_KEY` | Optional — web UI autocomplete |

## Architecture in one paragraph

A user submits an address or PIN via Slack slash command or the web UI. The **resolver** (`src/resolver/`) queries Buncombe County GIS to normalize it into a `CanonicalProperty`. The **orchestrator** (`src/orchestrator/`) fans out 12 **fetchers** (`src/fetchers/`) in parallel — each fetcher hits a different county data source and records every HTTP call and produced artifact in Postgres via the **provenance recorder** (`src/provenance/recorder.ts`). Artifacts (PDFs, JSON) are stored in Vercel Blob. Results stream back to the caller via polling (`/api/web/status/:id`) or are uploaded to the Slack thread.

## Adding a new fetcher

1. Create `src/fetchers/myFetcher.ts` — implement the `Fetcher` interface from `src/types.ts`
2. Register it in `src/orchestrator/fetchers.ts` by adding it to `ALL_FETCHERS`
3. Use `httpFetch` from `src/lib/httpFetch.ts` for all HTTP calls (records provenance automatically)
4. Call `ctx.run.recorder.putArtifact(...)` for every file produced
5. Set `needsBrowser: true` and use `launchBrowser()` from `src/lib/browser.ts` if you need Playwright

```typescript
export const myFetcher: Fetcher = {
  id: 'my-fetcher',
  name: 'My Data Source',
  counties: ['buncombe'],
  needsBrowser: false,
  async run(ctx) {
    const data = await httpFetch(ctx, 'https://...', { label: 'My Source' });
    const buf = Buffer.from(JSON.stringify(data));
    await ctx.run.recorder.putArtifact({ runId: ctx.run.runId, fetcherCallId: ctx.run.fetcherCallId, label: 'My data (JSON)', contentType: 'application/json', bytes: buf });
    return { fetcher: 'my-fetcher', status: 'completed', files: [], data, durationMs: 0 };
  },
};
```

## Key files

| File | What it does |
|------|-------------|
| `src/types.ts` | All shared types — start here |
| `src/orchestrator/fetchers.ts` | Master fetcher registry |
| `src/orchestrator/runner.ts` | Fan-out execution logic |
| `src/resolver/index.ts` | Address/PIN → CanonicalProperty |
| `src/provenance/recorder.ts` | Records runs, HTTP hits, artifacts to Postgres |
| `src/provenance/factory.ts` | Picks filesystem vs Blob backend from env |
| `src/lib/browser.ts` | Playwright launcher (Chromium on Vercel, local Chrome in dev) |
| `src/lib/httpFetch.ts` | Instrumented HTTP fetch — use this, not raw fetch |
| `api/web/search.ts` | Web UI entry point |
| `api/slack/command.ts` | Slack slash command handler |

## Testing

```bash
npm test                # unit tests — no network, no creds
npm run test:integration  # hits live Buncombe County APIs (needs network)
npm run test:e2e          # hits https://henry-slack.vercel.app end-to-end
E2E_BASE_URL=http://localhost:3000 npm run test:e2e  # run e2e against local server
```

## Deploy

```bash
vercel --prod   # deploy to production
```

Vercel auto-runs `tsc` on deploy. No separate build step needed locally.

## Provenance model

Every run leaves a full audit trail in Postgres:

```
invocations → runs → fetcher_calls → http_hits
                                   → artifacts
```

Query the full trace at `GET /api/runs/:id`. Artifacts download via `GET /api/artifact/:id`.
