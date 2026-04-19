# Phase 8 — Scale Hardening (400 Concurrent Users)

**Goal:** Henry can handle 400 simultaneous users without hammering county APIs, blowing Neon connection limits, or timing out browser fetchers. This phase converts the current `waitUntil()` fan-out into a durable queue-based system and adds the Neon connection pooler.

**Time estimate:** 2 days

**Prerequisite:** All previous phases. Caching (Phase 2) must be done first — it reduces the load multiplier dramatically.

---

## The math at 400 concurrent users

With Phase 2 caching, assume 40% cache hit rate (conservative for a busy market). That means 240 of 400 searches actually run fetchers.

Without this phase:
- 240 × 12 fetchers = 2,880 simultaneous HTTP requests to county servers
- 2,880 simultaneous `waitUntil()` background jobs in Vercel Functions
- 2,880 simultaneous Neon connections (instantly crashes the free/launch Neon plan)

With this phase:
- Fetchers run through a **Vercel Queue** with a concurrency cap
- Neon connections go through **PgBouncer** (Neon's built-in connection pooler)
- External API calls are rate-limited per-host
- Browser fetchers have a dedicated concurrency limit

Target: Henry behaves correctly at 400 concurrent users. Response time degrades gracefully (queue wait visible in UI) rather than crashing.

---

## Step 1 — Upgrade Neon to Scale plan and enable connection pooling

1.1. Go to neon.tech → your project → Settings → Compute. Upgrade to the Scale plan ($69/month as of 2026). This gives you more compute units and higher connection limits.

1.2. Enable PgBouncer: Neon Dashboard → Connection Details → Enable connection pooling. Neon generates a separate pooler connection string.

1.3. Add to `.env.example`:
```bash
DATABASE_URL_POOLED=postgresql://neondb_owner:...@ep-xxx.pooler.us-east-2.aws.neon.tech/neondb?sslmode=require&pgbouncer=true
```

1.4. Update `src/provenance/factory.ts` to use the pooled URL for all serverless-context code (search handler, fetcher handlers) and the direct URL only for migrations:

```typescript
// In makeProvenanceStack():
const connectionString =
  process.env.DATABASE_URL_POOLED ??    // pooled for serverless
  process.env.DATABASE_URL;             // direct for scripts/migrations

const pool = new Pool({
  connectionString,
  max: 5,              // per-function max connections (PgBouncer handles the rest)
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
});
```

---

## Step 2 — Set up Vercel Queues

Vercel Queues (public beta as of 2026) gives you durable, at-least-once delivery for background jobs. Replace the current `waitUntil(Promise.all(...12 fetchers...))` pattern with enqueuing one job per fetcher into a queue.

2.1. Enable Vercel Queues in the Vercel Dashboard → Integrations → Queues → Create Queue.

Create queue: `henry-fetcher-queue` with:
- Concurrency: 50 (handles 50 simultaneous fetcher jobs — enough for ~4 concurrent full searches)
- Visibility timeout: 300s (matches fetcher timeout)
- Max retries: 2

2.2. Install the Queues SDK:
```bash
npm install @vercel/queues@latest
```

2.3. Add queue env vars (auto-provisioned by Vercel after queue creation):
```bash
# Auto-set by Vercel when you create a queue:
VERCEL_QUEUE_henry_fetcher_queue_URL=...
VERCEL_QUEUE_henry_fetcher_queue_TOKEN=...
```

---

## Step 3 — Refactor search fan-out to use the queue

Currently in `api/web/search.ts`, `runWebFanOut` fires `Promise.all()` of 12 fetcher HTTP calls inside `waitUntil()`. Replace this with enqueueing one message per fetcher.

Update `api/web/search.ts`:

```typescript
import { Queue } from '@vercel/queues';

interface FetcherJobPayload {
  runId: string;
  invocationId: string;
  fetcherId: string;
  property: CanonicalProperty;
  baseUrl: string;
  internalToken: string | null;
}

const fetcherQueue = new Queue<FetcherJobPayload>('henry-fetcher-queue');

// Replace runWebFanOut() call with:
waitUntil(enqueueFetchers(recorder, property, baseUrl));

async function enqueueFetchers(
  recorder: ProvenanceRecorder,
  property: CanonicalProperty,
  baseUrl: string | null,
): Promise<void> {
  const active = ALL_FETCHERS.filter((f) => f.counties.includes(property.county));
  await recorder.setFetchersPlanned(active.length);

  const internalToken = process.env.HENRY_INTERNAL_TOKEN ?? null;

  await Promise.all(
    active.map((f) =>
      fetcherQueue.sendMessage({
        runId: recorder.runId,
        invocationId: recorder.invocation.id,
        fetcherId: f.id,
        property,
        baseUrl: baseUrl ?? '',
        internalToken,
      })
    )
  );
  // Messages are now durable — no need to wait for fetchers to complete here
}
```

---

## Step 4 — Queue consumer: fetcher worker

Create `api/queues/henry-fetcher-queue.ts` — Vercel auto-routes queue messages to a file matching the queue name.

```typescript
/**
 * Vercel Queue consumer for henry-fetcher-queue.
 * Each message triggers one fetcher for one run.
 * Vercel retries on failure up to the queue's max-retries setting.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ALL_FETCHERS } from '../../src/orchestrator/fetchers.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { ProvenanceRecorder } from '../../src/provenance/recorder.js';
import { canonicalToSnapshot } from '../../src/provenance/snapshot.js';
import { log } from '../../src/lib/log.js';
import type { FetcherJobPayload } from '../web/search.js'; // export the type from search.ts

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const job = req.body as FetcherJobPayload;
  const { runId, invocationId, fetcherId, property } = job;

  const fetcher = ALL_FETCHERS.find((f) => f.id === fetcherId);
  if (!fetcher) {
    log.error('queue_unknown_fetcher', { fetcherId, runId });
    res.status(200).end(); // ack so it doesn't retry for an unknown fetcher
    return;
  }

  const stack = await makeProvenanceStack();
  const hlog = log.child({ runId, fetcherId });

  try {
    hlog.info('queue_fetcher_start');

    // Execute the fetcher via the existing per-fetcher HTTP API
    const resp = await fetch(`${job.baseUrl}/api/fetchers/${fetcherId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(job.internalToken ? { 'x-henry-internal': job.internalToken } : {}),
      },
      body: JSON.stringify({ runId, invocationId, property }),
      signal: AbortSignal.timeout(280_000),
    });

    if (!resp.ok) {
      throw new Error(`Fetcher HTTP ${resp.status}`);
    }

    hlog.info('queue_fetcher_complete');
    res.status(200).end(); // ack

    // Check if this was the last fetcher for the run and finalize if so
    // (see Step 5 — run finalization)

  } catch (err) {
    hlog.error('queue_fetcher_error', { err: String(err) });
    // Return 500 to trigger Vercel Queue retry
    res.status(500).json({ error: String(err) });
  }
}
```

---

## Step 5 — Run finalization: detecting when all fetchers are done

With the queue model, you no longer have a single `Promise.all()` that resolves when all 12 fetchers finish. You need to detect completion atomically.

Add a `fetchers_finished` counter to the `runs` table:

```sql
-- Migration 007
ALTER TABLE runs ADD COLUMN IF NOT EXISTS fetchers_finished INTEGER NOT NULL DEFAULT 0;
```

In the queue consumer, after a fetcher completes, atomically increment the counter and check if all fetchers are done:

```typescript
// After successful fetcher execution:
const { rows } = await stack.store.pool.query(
  `UPDATE runs
   SET fetchers_finished = fetchers_finished + 1
   WHERE id = $1
   RETURNING fetchers_finished, fetchers_total, status`,
  [runId]
);

const run = rows[0];
if (run && run.fetchers_finished >= run.fetchers_total && run.status === 'running') {
  // This fetcher was the last one — finalize the run
  const { rows: failRows } = await stack.store.pool.query(
    `SELECT COUNT(*) AS failed FROM fetcher_calls WHERE run_id = $1 AND status IN ('failed','timeout')`,
    [runId]
  );
  const failedCount = parseInt(failRows[0]?.failed ?? '0', 10);
  const finalStatus = failedCount === 0 ? 'completed' : failedCount < run.fetchers_total ? 'partial' : 'failed';

  await stack.store.pool.query(
    `UPDATE runs SET status = $1, finished_at = NOW(),
       duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000
     WHERE id = $2 AND status = 'running'`,
    [finalStatus, runId]
  );

  // Write to PIN cache if successful
  if (finalStatus === 'completed' || finalStatus === 'partial') {
    await stack.store.setPinCache('buncombe', property.pin, runId);
  }
}
```

---

## Step 6 — External API rate limiting per host

The current `httpFetch` wrapper makes no attempt to throttle calls to the same host. At scale, 50 concurrent fetcher jobs might all hit `gis.buncombecounty.org` simultaneously.

Add a simple in-memory rate limiter keyed by hostname. Because each Vercel Function instance is isolated, this only limits within a single instance — but combined with the queue concurrency cap of 50, it's sufficient.

Create `src/lib/rateLimiter.ts`:

```typescript
/**
 * Simple per-host rate limiter for outbound HTTP calls.
 * Limits calls to the same hostname to avoid triggering county server throttling.
 * Uses a token bucket algorithm.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, Bucket>();

// Conservative limits per host (requests per second)
const HOST_LIMITS: Record<string, number> = {
  'gis.buncombecounty.org': 3,
  'maps.co.buncombe.nc.us': 3,
  'hazards.fema.gov': 5,
  'msc.fema.gov': 3,
  'nationalmap.gov': 5,
  'sdmdataaccess.sc.egov.usda.gov': 3,
  // Default for unlisted hosts
  _default: 10,
};

export async function acquireRateLimit(url: string): Promise<void> {
  const hostname = new URL(url).hostname;
  const rps = HOST_LIMITS[hostname] ?? HOST_LIMITS._default;
  const refillMs = 1000 / rps;

  const now = Date.now();
  let bucket = buckets.get(hostname);
  if (!bucket) {
    bucket = { tokens: rps, lastRefill: now };
    buckets.set(hostname, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  const newTokens = (elapsed / refillMs) * 1;
  bucket.tokens = Math.min(rps, bucket.tokens + newTokens);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return; // no wait needed
  }

  // Wait until a token is available
  const waitMs = (1 - bucket.tokens) * refillMs;
  await new Promise((r) => setTimeout(r, Math.ceil(waitMs)));
  bucket.tokens = 0;
  bucket.lastRefill = Date.now();
}
```

Update `src/lib/httpFetch.ts` to call `acquireRateLimit(url)` before each fetch.

---

## Step 7 — Browser fetcher concurrency cap

Browser-based fetchers (those with `needsBrowser: true`) are the most resource-intensive. They spin up a Chromium instance inside a Vercel Function. At scale, limit these to run at most 3 simultaneously across the entire system.

Implement this as a separate Vercel Queue: `henry-browser-fetcher-queue` with `concurrency: 3`.

Non-browser fetchers use `henry-fetcher-queue` (concurrency 50). In the enqueue step, route based on `fetcher.needsBrowser`:

```typescript
const queue = fetcher.needsBrowser ? browserFetcherQueue : fetcherQueue;
await queue.sendMessage({ ... });
```

---

## Step 8 — Add queue depth to the run status response

The web UI currently polls `/api/web/status/:id` to show progress. With the queue model, a fetcher might be "pending" in the queue, not just "running." Expose queue position so the UI can show "2 fetchers waiting in queue" instead of looking stuck.

This requires querying the `fetcher_calls` table for pending count vs. running count — both states already exist in the schema. No API changes needed; the existing `fetcherStatuses` object already differentiates `'pending'` from `'running'`.

Update the loading UI in `web/app/property/[runId]/page.tsx` to show a more informative message when many fetchers are still pending:

```tsx
const pendingCount = Object.values(runStatus.fetcherStatuses).filter(s => s === 'pending').length;
const runningCount = Object.values(runStatus.fetcherStatuses).filter(s => s === 'running').length;

// In ProgressBar, show:
// "12 fetchers queued" (initial state)
// "Fetching data · 3 running, 5 complete" (mid-run)
// "Finalizing…" (all done, awaiting finalization)
```

---

## Step 9 — Load testing before launch

Before opening to real users, simulate 400 concurrent users locally using [k6](https://k6.io):

Install: `brew install k6`

Create `tests/load/search.js`:
```javascript
import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },   // ramp up to 50 users
    { duration: '2m', target: 200 },   // hold at 200
    { duration: '30s', target: 400 },  // peak: 400 simultaneous
    { duration: '1m', target: 0 },     // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],  // 95% of requests under 2s
    http_req_failed: ['rate<0.01'],     // <1% error rate
  },
};

// Use a pre-generated list of real Buncombe County PINs
const PINS = [
  '9648682278800000',
  '9648582003200000',
  // ... add 20 or so real PINs
];

export default function () {
  const pin = PINS[Math.floor(Math.random() * PINS.length)];
  const res = http.post(
    'https://henry-slack.vercel.app/api/web/search',
    JSON.stringify({ address: pin }),
    { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer test-token' } }
  );
  // Expect 200 (cache hit) or 202 (new run started)
  if (res.status !== 200 && res.status !== 202) {
    console.error(`Unexpected status ${res.status} for PIN ${pin}`);
  }
  sleep(Math.random() * 3); // stagger requests
}
```

Run: `k6 run tests/load/search.js`

Watch during the test:
- Vercel Dashboard → Functions → concurrent invocations (should not spike above queue concurrency)
- Neon Dashboard → Compute → connection count (should stay under pool limits)
- PostHog → `search_started` event volume in real time

---

## Step 10 — Monitoring and alerting

Set up basic alerting so you know when things break before users complain.

**Vercel alerting:** Project → Settings → Alerts → Function Errors. Alert when error rate >2% in a 5-minute window.

**Neon alerting:** Neon Dashboard → Monitoring → Set up alerts for CPU >80% and connection count >80% of limit.

**PostHog alerting:** Create a PostHog alert on `search_completed` where `status = 'failed'` — if >5 failures in 10 minutes, send an email.

**Health check cron** — extend the existing `npm run health-check` to run as a scheduled job:

Add to `vercel.json` crons:
```json
{ "path": "/api/cron/health", "schedule": "*/15 * * * *" }
```

Create `api/cron/health.ts` that runs the golden-property fetch for 3 critical fetchers (parcel-json, fema-flood, str-eligibility) and logs failures to PostHog. If any fail, POST to a Slack webhook to alert you.

---

## Definition of done

- [ ] Neon on Scale plan with PgBouncer connection pooling URL in use
- [ ] Fetcher fan-out uses Vercel Queues (not `waitUntil` + `Promise.all`)
- [ ] Browser fetchers on separate queue with concurrency capped at 3
- [ ] External API rate limiter active in `httpFetch`
- [ ] Load test passes: 400 concurrent users, <1% error rate, p95 ACK latency <2s
- [ ] Health check cron running every 15 minutes
- [ ] Vercel and Neon alerting configured
- [ ] `npm run lint` passes
