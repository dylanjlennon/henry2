# Henry — Slack property research for Buncombe County, NC

Paste a PIN or an address into any Slack channel, get a complete research
package back in the thread: parcel record, tax bill, deed, plat, FEMA flood,
septic status, permits. Every produced fact is traceable back to the exact
URL it came from via a permanent run-trace link.

## How to use

```
/henry 546 Old Haw Creek Rd
/henry 9648-65-1234-00000
/henry                           ← in a deal channel like #546-old-haw-creek-rd, leave blank
@henry 546 Old Haw Creek Rd      ← or mention the bot in any channel it's in
```

Henry responds in the thread with:
1. The resolved property (PIN, address, owner, deed/plat book/page, centroid)
   plus a link to the full run trace.
2. Live progress updates as each fetcher completes.
3. A summary + each produced file uploaded as a Slack attachment.
4. A final "full trace" link back to `/api/runs/:id`.

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
                       │                  │
                       │                  ├──►  REST fetchers (parcel, FEMA, septic)
                       │                  └──►  Browser fetchers (tax bill, deed, plat, …)
                       │
                       ▼
                 ProvenanceRecorder ──► Postgres (invocations, runs,
                                        │        fetcher_calls, http_hits,
                                        │        artifacts)
                                        └──►   Vercel Blob (artifact bytes)
                       │
                       ▼
              Slack thread: files uploaded, trace URL posted
```

### Key modules

- `src/resolver/` — PIN/address → `CanonicalProperty`. Uses Buncombe GIS
  parcel + address-points layers; spatial fallback when the address layer
  doesn't carry a PIN.
- `src/sources/buncombe.ts` — canonical URL catalog. Every external URL we
  hit lives here; integration tests probe each against the live service.
- `src/fetchers/` — one module per data source. Each exposes a `Fetcher`
  with `run(ctx)` that returns a `FetcherResult` and registers artifacts
  via `ctx.run.recorder.putArtifact(...)`.
- `src/orchestrator/` — runs fetchers in parallel, opens a `FetcherCall`
  row per fetcher, streams progress, aggregates results.
- `src/provenance/` — the audit layer: schemas, storage abstractions,
  `ProvenanceRecorder`, Postgres + Blob backends, memory-backed test
  doubles.
- `src/slack/` — Slack transport. Signature verification, channel-name
  inference, the handler that ties resolution → orchestration → Slack
  posting.
- `api/slack/*.ts` — Vercel serverless entry points.
- `api/runs/*.ts` — Read API over the provenance store.

## Provenance model

Every externally-sourced fact is linked through a five-level chain:

```
  Invocation  (someone asked Henry for a property)
     ↓
  Run         (one execution of the orchestrator)
     ↓
  FetcherCall (one fetcher module's work within a run)
     ↓
  HttpHit     (a single HTTP request to an external source)
     ↓
  Artifact    (a file / JSON blob produced, with its SHA-256 digest)
```

Given any artifact or data point you can answer:
- Who asked for this? Which Slack user, channel, thread?
- When exactly did the fetch happen?
- What was the response code? How big was the body?
- What's the content hash, so we can detect silent upstream changes?
- What version of Henry and what version of this fetcher ran?

Query it with SQL or via `GET /api/runs/:id`, which returns the full
`RunTrace`:

```json
{
  "invocation": { "trigger": "slack-slash", "slackUserId": "U…", "rawInput": "…" },
  "run":        { "id": "…", "status": "completed", "totals": { … } },
  "fetcherCalls": [ { "fetcherId": "fema-flood", "durationMs": 412, … } ],
  "httpHits":   [ { "url": "https://…", "status": 200, "responseSha256": "…", "durationMs": 87, … } ],
  "artifacts":  [ { "label": "Parcel record (JSON)", "sha256": "…", "storageUri": "https://…blob.vercel-storage.com/…" } ]
}
```

## Development

```bash
npm install
npm test                              # all tests
npm run test:unit                     # fast unit tests (offline)
npm run test:integration              # hits live Buncombe + FEMA APIs
npm run lint                          # type-check only

# CLI — resolves and runs all fetchers; provenance goes to in-memory store
tsx scripts/resolve.ts "546 Old Haw Creek Rd"
tsx scripts/fetch.ts   "546 Old Haw Creek Rd"
```

Default provenance backends for local dev: `MemoryProvenanceStore` +
`FilesystemArtifactStore` (artifacts land in `$TMPDIR/henry-artifacts`).
Set `PROVENANCE_BACKEND=postgres` + `DATABASE_URL` to use a real database
locally.

## Deploy

1. **Create the Slack app.** Go to <https://api.slack.com/apps> → Create New
   App → From a manifest. Paste `slack-app-manifest.yaml` (edit the two URLs
   to your Vercel deployment first). Install to workspace.
2. **Provision storage.**
   - **Postgres** (Vercel Postgres, Neon, or Supabase). Run
     `src/provenance/migrations/001_init.sql` to create the schema.
   - **Vercel Blob** store (Vercel dashboard → Storage → Create Blob Store).
3. **Deploy to Vercel.**
   ```bash
   vercel --prod
   ```
4. **Set environment variables in Vercel:**
   - `SLACK_BOT_TOKEN` — bot user OAuth token (starts with `xoxb-`)
   - `SLACK_SIGNING_SECRET` — from the Slack app's Basic Information page
   - `DATABASE_URL` — Postgres connection string (with `sslmode=require`)
   - `BLOB_READ_WRITE_TOKEN` — from Vercel Blob
   - `PROVENANCE_BACKEND=postgres`
   - `ARTIFACT_BACKEND=vercel-blob`
   - `PUBLIC_BASE_URL=https://<your-app>.vercel.app` (enables clickable
     trace links in Slack messages)
   - `HENRY_API_TOKEN` (optional) — Bearer token required for `/api/runs/*`
5. **Verify event subscription URL** in the Slack app (it should say
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
| `tests/unit/provenance.test.ts`       | Recorder lifecycle, request-hash determinism, HTTP instrumentation |
| `tests/integration/sources.live.test.ts` | Every canonical URL validated against live API |
| `tests/integration/fetchers.live.test.ts` | Each fetcher produces real output AND populates provenance rows |

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
- [x] Provenance: schemas + recorder + Postgres + Blob + /api/runs
- [x] GitHub Actions CI
- [ ] Browser fetchers (tax bill PDF, PRC PDF, deed, plat, GIS map, FIRMette)
- [ ] Vercel deployment wired to Slack
