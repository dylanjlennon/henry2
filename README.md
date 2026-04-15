# Henry — Slack property research for Buncombe County, NC

Paste a PIN or an address into any Slack channel, get a complete research
package back in the thread: parcel record, tax bill, deed, plat, FEMA flood,
septic status, permits. Works from any channel in the workspace.

## How to use

```
/henry 546 Old Haw Creek Rd
/henry 9648-65-1234-00000
/henry                           ← in a deal channel like #546-old-haw-creek-rd, leave blank
@henry 546 Old Haw Creek Rd      ← or mention the bot in any channel it's in
```

Henry responds in the thread with:
1. The resolved property (PIN, address, owner, deed/plat book/page, centroid).
2. Live progress updates as each fetcher completes.
3. A summary + each produced file uploaded as a Slack attachment.

## Architecture

```
 Slack  ─┬──►  /api/slack/command   (slash command)
         └──►  /api/slack/events    (@mention)
                       │
                       ▼
                 slack/handler  ──►  resolver  ──►  Buncombe GIS REST
                       │
                       ▼
                 orchestrator  ──►  fetchers (parallel)
                       │
                       ├──►  REST fetchers       (parcel JSON, FEMA flood, septic)
                       └──►  Browser fetchers    (tax bill, PRC, deed, plat, GIS map, FIRMette)
                                     │
                                     ▼
                               files uploaded back to Slack thread
```

### Key modules

- `src/resolver/` — PIN/address → `CanonicalProperty`. Uses Buncombe GIS
  parcel + address-points layers; spatial fallback when the address layer
  doesn't carry a PIN.
- `src/sources/buncombe.ts` — canonical URL catalog. Every external URL we
  hit lives here; integration tests probe each against the live service.
- `src/fetchers/` — one module per data source. Each exposes a `Fetcher`
  with `run(ctx)` that returns a `FetcherResult`.
- `src/orchestrator/` — runs fetchers in parallel, streams progress events,
  aggregates results.
- `src/slack/` — Slack transport. Signature verification, channel-name
  inference, the handler that ties resolution → orchestration → Slack
  posting.
- `api/slack/*.ts` — Vercel serverless entry points.

## Development

```bash
npm install
npm test                              # all tests (unit + integration)
npm run test:unit                     # fast unit tests only
npm run test:integration              # hits live Buncombe + FEMA APIs
npm run lint                          # type-check only

# CLI tools for working without Slack
tsx scripts/resolve.ts "546 Old Haw Creek Rd"
tsx scripts/fetch.ts   "546 Old Haw Creek Rd"
```

## Deploy

1. **Create the Slack app.** Go to <https://api.slack.com/apps> → Create New
   App → From a manifest. Paste `slack-app-manifest.yaml` (edit the two URLs
   to your Vercel deployment first). Install to workspace.
2. **Deploy to Vercel.**
   ```bash
   vercel --prod
   ```
3. **Set environment variables in Vercel:**
   - `SLACK_BOT_TOKEN` — bot user OAuth token (starts with `xoxb-`)
   - `SLACK_SIGNING_SECRET` — from the Slack app's Basic Information page
4. **Verify event subscription URL** in the Slack app (it should say
   "Verified" automatically after deploy).

## Testing strategy

Every external URL has a live probe in `tests/integration/sources.live.test.ts`.
If Buncombe County changes a URL or field name, the test fails loudly — you
know exactly what broke.

| Test file | What it covers |
|-----------|----------------|
| `tests/unit/normalizeAddress.test.ts` | Address parsing edge cases, USPS abbreviations, punctuation |
| `tests/unit/pin.test.ts`              | PIN format conversion (dashed ↔ 15-digit) |
| `tests/unit/channelName.test.ts`      | Channel-name → property inference |
| `tests/unit/signature.test.ts`        | Slack HMAC signature verification |
| `tests/integration/sources.live.test.ts` | Every canonical URL validated against live API |
| `tests/integration/fetchers.live.test.ts` | Each fetcher produces real output for golden property |

## Adding a new county

1. Write an adapter under `src/resolver/adapters/<county>.ts` that exports
   `lookupParcelByPin` and `searchAddress`.
2. Add the county id to the `CountyId` union in `src/types.ts`.
3. Add any county-specific URLs to a new `src/sources/<county>.ts`.
4. Wire the county into `src/resolver/index.ts`.

Fetchers that aren't county-specific (e.g. FEMA, USPS) work as-is.

## Status

- [x] Resolver (PIN + fuzzy address)
- [x] Canonical URL catalog + live validation
- [x] REST fetchers (parcel, FEMA flood, septic)
- [x] Orchestrator + progress streaming
- [x] Slack handler + signature verification
- [x] Vercel API routes
- [ ] Browser fetchers (tax bill PDF, PRC PDF, deed, plat, GIS map, FIRMette)
- [ ] Vercel deployment wired to Slack
