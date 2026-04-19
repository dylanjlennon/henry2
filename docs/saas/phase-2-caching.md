# Phase 2 — Result Caching

**Goal:** If a property's data was fetched within the last 24 hours, return the cached result instantly — no fetchers run, no county APIs hit, no credit consumed. This is the single most important scale fix and also meaningfully improves UX (repeat searches feel instant).

**Time estimate:** 1 day

**Prerequisite:** Phase 1 complete (user table exists)

**Tech:** Neon Postgres (migration 005), updated search handler

---

## Why 24 hours

Property data from Buncombe County GIS changes rarely — typically on a weekly batch cycle. Deed records, tax values, and parcel boundaries are stable for months. FEMA flood zones almost never change. 24-hour cache gives a strong freshness guarantee while cutting upstream load by ~80% in normal operation (agents repeatedly look at the same small set of active listings).

A cache hit:
- Returns in <200ms instead of ~120 seconds
- Costs the user zero credits
- Makes zero external API calls
- Is clearly labeled in the UI as "cached result from [time]"

---

## Step 1 — Database migration: pin_cache table

Create `src/provenance/migrations/005_pin_cache.sql`:

```sql
-- Henry provenance schema, migration 005.
-- Adds a 24-hour result cache keyed by (county, pin, cache_date).
-- A cache hit returns the run_id of the most recent completed run
-- for that PIN on that calendar date (UTC).

CREATE TABLE IF NOT EXISTS pin_cache (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  county      TEXT NOT NULL DEFAULT 'buncombe',
  pin         TEXT NOT NULL,
  cache_date  DATE NOT NULL,           -- UTC date the run completed
  run_id      UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (county, pin, cache_date)
);

CREATE INDEX IF NOT EXISTS pin_cache_lookup_idx
  ON pin_cache (county, pin, cache_date DESC);

-- Automatically clean up cache entries older than 7 days
-- (keeps the table small; 24-hour TTL is enforced in app logic)
CREATE INDEX IF NOT EXISTS pin_cache_cleanup_idx
  ON pin_cache (cache_date);
```

Run migration:
```bash
node --input-type=module << 'EOF'
import pg from './node_modules/pg/lib/index.js';
import { readFileSync } from 'fs';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await pool.query(readFileSync('src/provenance/migrations/005_pin_cache.sql', 'utf8'));
console.log('Migration 005 applied');
await pool.end();
EOF
```

---

## Step 2 — Add cache lookup and write methods to ProvenanceStore

Add to `src/provenance/store.ts` (the interface):

```typescript
export interface ProvenanceStore {
  // ... existing methods ...

  /**
   * Look up a cached run for (county, pin) on today's UTC date.
   * Returns the runId if a valid cache entry exists, null otherwise.
   */
  getPinCacheHit(county: string, pin: string): Promise<string | null>;

  /**
   * Record a completed run in the cache.
   * Safe to call multiple times — uses ON CONFLICT DO NOTHING.
   */
  setPinCache(county: string, pin: string, runId: string): Promise<void>;

  /**
   * Delete cache entries older than maxAgeDays. Run periodically.
   */
  evictStalePinCache(maxAgeDays?: number): Promise<number>;
}
```

---

## Step 3 — Implement cache methods in PostgresProvenanceStore

Add to `src/provenance/postgresStore.ts`:

```typescript
async getPinCacheHit(county: string, pin: string): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const { rows } = await this.pool.query<{ run_id: string }>(
    `SELECT pc.run_id
     FROM pin_cache pc
     JOIN runs r ON r.id = pc.run_id
     WHERE pc.county = $1
       AND pc.pin = $2
       AND pc.cache_date = $3
       AND r.status IN ('completed', 'partial')
     ORDER BY pc.created_at DESC
     LIMIT 1`,
    [county, pin, today]
  );
  return rows[0]?.run_id ?? null;
}

async setPinCache(county: string, pin: string, runId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await this.pool.query(
    `INSERT INTO pin_cache (county, pin, cache_date, run_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (county, pin, cache_date) DO UPDATE SET
       run_id = EXCLUDED.run_id,
       created_at = NOW()`,
    [county, pin, today, runId]
  );
}

async evictStalePinCache(maxAgeDays = 7): Promise<number> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - maxAgeDays);
  const { rowCount } = await this.pool.query(
    `DELETE FROM pin_cache WHERE cache_date < $1`,
    [cutoff.toISOString().slice(0, 10)]
  );
  return rowCount ?? 0;
}
```

Also add stub implementations to `src/provenance/memoryStore.ts` (for tests):

```typescript
private pinCache: Map<string, string> = new Map();

async getPinCacheHit(county: string, pin: string): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10);
  return this.pinCache.get(`${county}:${pin}:${today}`) ?? null;
}

async setPinCache(county: string, pin: string, runId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  this.pinCache.set(`${county}:${pin}:${today}`, runId);
}

async evictStalePinCache(): Promise<number> { return 0; }
```

---

## Step 4 — Wire cache check into the search handler

Update `api/web/search.ts`. The cache check happens after property resolution (we need the PIN) but before we create an invocation or run fetchers:

```typescript
// After `property` is resolved, before creating the invocation:

// Check cache
const cachedRunId = await stack.store.getPinCacheHit(property.county, property.pin);
if (cachedRunId) {
  // Cache hit — return immediately, no fetchers run, no credit consumed
  res.status(200).json({
    runId: cachedRunId,
    pin: property.pin,
    address: property.address ?? address,
    ownerName: property.ownerName ?? null,
    confidence: property.confidence,
    estimatedMs: 0,
    cached: true,             // flag so the UI can show "Cached result"
    cacheDate: new Date().toISOString().slice(0, 10),
  });
  return;
}

// Cache miss — proceed with full run (existing code follows)
```

---

## Step 5 — Write to cache when a run completes successfully

In `api/web/search.ts` inside `runWebFanOut`, after `recorder.finishRun()`:

```typescript
// After finishRun succeeds and runStatus is 'completed' or 'partial':
if (runStatus === 'completed' || runStatus === 'partial') {
  try {
    await stack.store.setPinCache(property.county, property.pin, recorder.runId);
  } catch (e) {
    hlog.warn('pin_cache_write_failed', { err: String(e) });
    // non-fatal — cache miss on next search is fine
  }
}
```

---

## Step 6 — Expose cache status in the web status API

Update `api/web/status/[runId].ts` — add `cached` and `cachedAt` fields to the response so the frontend knows whether to show a "Cached" badge.

In the status response, query the `pin_cache` table to see if this runId was a cache source:

```typescript
// In the status handler, after fetching WebRunStatus:
const cacheRow = await stack.store.getPinCacheSourceDate(runId); // add this method
const response = {
  ...runStatus,
  cached: cacheRow !== null,
  cachedAt: cacheRow?.cacheDate ?? null,
};
```

Add `getPinCacheSourceDate` to the store:
```typescript
async getPinCacheSourceDate(runId: string): Promise<{ cacheDate: string } | null> {
  const { rows } = await this.pool.query(
    `SELECT cache_date FROM pin_cache WHERE run_id = $1 LIMIT 1`,
    [runId]
  );
  return rows[0] ? { cacheDate: rows[0].cache_date } : null;
}
```

---

## Step 7 — Show cache status in the UI

Update `web/types/property.ts` — add to `WebRunStatus`:
```typescript
cached?: boolean;
cachedAt?: string | null;
```

Update `web/components/PropertyHero.tsx` — below the address h1, if `runStatus.cached` is true, show a small pill:

```tsx
{runStatus.cached && (
  <div style={{
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    fontSize: 'var(--font-size-label)',
    color: 'var(--color-muted)',
    background: 'var(--color-sunken)',
    border: '1px solid var(--color-rule)',
    borderRadius: 'var(--radius-pill)',
    padding: '2px 10px',
    marginTop: '6px',
  }}>
    ⚡ Cached result · data from today
  </div>
)}
```

---

## Step 8 — Cache invalidation endpoint (admin use)

Add `api/admin/invalidate-cache.ts` — a POST endpoint that takes `{ pin, county }` and deletes the cache entry for today. Protected by a static `HENRY_ADMIN_TOKEN` env var. Use this when you know a property's data has changed and you want to force a fresh fetch.

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeProvenanceStack } from '../../src/provenance/factory.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const token = req.headers['x-admin-token'];
  if (token !== process.env.HENRY_ADMIN_TOKEN) {
    res.status(403).json({ error: 'forbidden' }); return;
  }
  const { pin, county = 'buncombe' } = req.body as { pin: string; county?: string };
  const stack = await makeProvenanceStack();
  await stack.store.pool.query(
    `DELETE FROM pin_cache WHERE county = $1 AND pin = $2`,
    [county, pin]
  );
  res.status(200).json({ invalidated: true, pin, county });
}
```

Add `HENRY_ADMIN_TOKEN` to `.env.example` and Vercel project env vars.

---

## Step 9 — Scheduled cache eviction

Add a daily cron job to clean up stale entries. In `vercel.json` (or `vercel.ts` if you've migrated):

```json
{
  "crons": [
    {
      "path": "/api/cron/evict-cache",
      "schedule": "0 3 * * *"
    }
  ]
}
```

Create `api/cron/evict-cache.ts`:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeProvenanceStack } from '../../src/provenance/factory.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).end(); return;
  }
  const stack = await makeProvenanceStack();
  const deleted = await stack.store.evictStalePinCache(7);
  res.status(200).json({ deleted });
}
```

Add `CRON_SECRET` to Vercel env vars (generate a random UUID).

---

## Step 10 — Verify cache is working

10.1. Run a search for a known address.

10.2. Run the same search again immediately. It should:
- Return in <200ms
- Show `"cached": true` in the response
- Show the "⚡ Cached result" pill in the UI

10.3. Check the DB: `SELECT * FROM pin_cache ORDER BY created_at DESC LIMIT 5;`

10.4. Verify the second search did NOT create a new row in `invocations` (cache hits bypass invocation creation).

---

## Definition of done

- [ ] Same-PIN same-day search returns in <200ms with `cached: true`
- [ ] Cache hits do not run fetchers or touch external APIs
- [ ] Cache hits do not consume a user's search credit (Phase 4 enforces this)
- [ ] "⚡ Cached result" pill appears in UI for cache hits
- [ ] `pin_cache` row is written after every successful run
- [ ] Cache eviction cron is scheduled and working
- [ ] `npm run lint` passes
