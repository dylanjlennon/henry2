# Phase 4 — Usage Enforcement & Metering

**Goal:** Searches actually decrement a counter. Users on the free tier who hit 5 searches see a paywall. Paying users who hit their plan limit see an upgrade prompt. Cache hits never consume a credit.

**Time estimate:** 1 day

**Prerequisite:** Phase 1 (users table), Phase 2 (cache), Phase 3 (billing/plans)

---

## Step 1 — Usage event table (audit log for every search)

While the `users.searches_used` counter is the live gate, a separate events table gives you a queryable audit trail: when did this user search, which PIN, was it a cache hit, did they run out of credits.

Add to `src/provenance/migrations/006_usage_events.sql`:

```sql
-- Henry provenance schema, migration 006.
-- Per-search usage accounting: ties each search to a user,
-- records whether a credit was consumed, and the outcome.

CREATE TABLE IF NOT EXISTS usage_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  run_id        UUID REFERENCES runs(id),
  pin           TEXT,
  cached        BOOLEAN NOT NULL DEFAULT false,  -- true = no credit consumed
  credit_used   BOOLEAN NOT NULL DEFAULT false,  -- true = decremented searches_used
  plan_at_time  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_events_user_idx ON usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_events_created_at_idx ON usage_events (created_at DESC);
```

Run migration (same pattern as previous migrations).

---

## Step 2 — Credit check utility

Create `src/lib/credits.ts`:

```typescript
import type { Pool } from 'pg';
import { log } from './log.js';

export type CreditCheckResult =
  | { allowed: true; creditRequired: boolean; searchesRemaining: number }
  | { allowed: false; reason: 'limit_reached' | 'subscription_past_due'; searchesRemaining: 0; plan: string };

/**
 * Check if a user is allowed to run a search.
 * Does NOT decrement the counter — call consumeCredit() after a successful run starts.
 */
export async function checkCredit(pool: Pool, userId: string): Promise<CreditCheckResult> {
  const { rows } = await pool.query<{
    plan: string; searches_used: number; searches_limit: number; subscription_status: string | null;
  }>(
    `SELECT plan, searches_used, searches_limit, subscription_status
     FROM users WHERE id = $1`,
    [userId]
  );

  if (!rows[0]) {
    return { allowed: false, reason: 'limit_reached', searchesRemaining: 0, plan: 'free' };
  }

  const { plan, searches_used, searches_limit, subscription_status } = rows[0];

  // Block past_due accounts from running new searches
  if (subscription_status === 'past_due') {
    return { allowed: false, reason: 'subscription_past_due', searchesRemaining: 0, plan };
  }

  const remaining = searches_limit - searches_used;
  if (remaining <= 0) {
    return { allowed: false, reason: 'limit_reached', searchesRemaining: 0, plan };
  }

  return { allowed: true, creditRequired: true, searchesRemaining: remaining };
}

/**
 * Atomically decrement searches_used.
 * Returns false if the user is now at their limit (race condition guard).
 */
export async function consumeCredit(pool: Pool, userId: string): Promise<boolean> {
  const { rows } = await pool.query<{ searches_used: number; searches_limit: number }>(
    `UPDATE users
     SET searches_used = searches_used + 1
     WHERE id = $1 AND searches_used < searches_limit
     RETURNING searches_used, searches_limit`,
    [userId]
  );
  if (!rows[0]) {
    log.warn('credit_consume_failed_already_at_limit', { userId });
    return false;
  }
  return true;
}

/**
 * Record a usage event in the audit log.
 */
export async function recordUsageEvent(pool: Pool, opts: {
  userId: string;
  runId: string | null;
  pin: string | null;
  cached: boolean;
  creditUsed: boolean;
  planAtTime: string;
}): Promise<void> {
  await pool.query(
    `INSERT INTO usage_events (user_id, run_id, pin, cached, credit_used, plan_at_time)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [opts.userId, opts.runId, opts.pin, opts.cached, opts.creditUsed, opts.planAtTime]
  );
}
```

---

## Step 3 — Wire credit check into the search handler

Update `api/web/search.ts`. The gate logic:

1. Cache hit → no credit consumed, allowed for all users (even over-limit)
2. Cache miss + user at limit → 402 with upgrade prompt
3. Cache miss + user has credits → consume credit, run fetchers

```typescript
import { checkCredit, consumeCredit, recordUsageEvent } from '../../src/lib/credits.js';

// After cache check (cache hit path):
if (cachedRunId) {
  // Record cache hit in usage log (no credit consumed)
  void recordUsageEvent(stack.store.pool, {
    userId: user.id,
    runId: cachedRunId,
    pin: property.pin,
    cached: true,
    creditUsed: false,
    planAtTime: user.plan,
  });

  res.status(200).json({
    runId: cachedRunId,
    pin: property.pin,
    address: property.address ?? address,
    ownerName: property.ownerName ?? null,
    confidence: property.confidence,
    estimatedMs: 0,
    cached: true,
  });
  return;
}

// Cache miss — check credits before running fetchers
const creditCheck = await checkCredit(stack.store.pool, user.id);
if (!creditCheck.allowed) {
  const message =
    creditCheck.reason === 'subscription_past_due'
      ? 'Your subscription payment failed. Please update your payment method to continue searching.'
      : `You've used all ${user.searchesLimit} searches this month. Upgrade to continue.`;

  res.status(402).json({
    error: message,
    reason: creditCheck.reason,
    plan: user.plan,
    upgradeUrl: `${getBaseUrl()}/pricing`,
  });
  return;
}

// Consume credit before firing fetchers (prevents race conditions)
const consumed = await consumeCredit(stack.store.pool, user.id);
if (!consumed) {
  res.status(402).json({
    error: 'Search limit reached. Upgrade to continue.',
    reason: 'limit_reached',
    plan: user.plan,
    upgradeUrl: `${getBaseUrl()}/pricing`,
  });
  return;
}

// Record credit consumption (will update runId after run starts)
void recordUsageEvent(stack.store.pool, {
  userId: user.id,
  runId: null, // filled in below after recorder.startRun()
  pin: property.pin,
  cached: false,
  creditUsed: true,
  planAtTime: user.plan,
}).catch(() => {}); // non-fatal
```

---

## Step 4 — Show remaining searches in the UI header

Users should always know how many searches they have left. Add a usage indicator to the app header.

Create `api/web/me.ts`:

```typescript
/**
 * GET /api/web/me
 * Returns the current user's plan, searches used, and limit.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAuth } from '@clerk/nextjs/server';
import { makeProvenanceStack } from '../../src/provenance/factory.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') { res.status(405).end(); return; }
  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) { res.status(401).end(); return; }

  const stack = await makeProvenanceStack();
  const { rows } = await stack.store.pool.query(
    `SELECT plan, searches_used, searches_limit, subscription_status
     FROM users WHERE clerk_id = $1`,
    [clerkUserId]
  );

  if (!rows[0]) { res.status(404).end(); return; }
  const { plan, searches_used, searches_limit, subscription_status } = rows[0];
  res.status(200).json({
    plan,
    searchesUsed: searches_used,
    searchesLimit: searches_limit,
    searchesRemaining: Math.max(0, searches_limit - searches_used),
    subscriptionStatus: subscription_status,
  });
}
```

Create `web/hooks/useMe.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';

interface MeData {
  plan: string;
  searchesUsed: number;
  searchesLimit: number;
  searchesRemaining: number;
  subscriptionStatus: string | null;
}

export function useMe() {
  return useQuery<MeData>({
    queryKey: ['me'],
    queryFn: async () => {
      const res = await fetch('/api/web/me');
      if (!res.ok) throw new Error('Failed to fetch user data');
      return res.json() as Promise<MeData>;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
}
```

Update `web/app/layout.tsx` header to show usage:

```tsx
import { useMe } from '@/hooks/useMe';

// In the header (client component):
const { data: me } = useMe();

// Show in header:
{me && (
  <span style={{ fontSize: 'var(--font-size-label)', color: me.searchesRemaining <= 2 ? 'var(--color-warn)' : 'var(--color-muted)' }}>
    {me.searchesRemaining}/{me.searchesLimit} searches
  </span>
)}
```

Note: the root layout needs to become a client component, or you extract the header into a separate `'use client'` component. Prefer the latter to keep the layout as a server component.

---

## Step 5 — Paywall UI component

When the API returns 402, show an upgrade prompt instead of an error.

Create `web/components/PaywallModal.tsx`:

```typescript
'use client';
import { useRouter } from 'next/navigation';

interface PaywallModalProps {
  reason: 'limit_reached' | 'subscription_past_due';
  plan: string;
  onDismiss: () => void;
}

export default function PaywallModal({ reason, plan, onDismiss }: PaywallModalProps) {
  const router = useRouter();

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 1000,
    }}
      onClick={onDismiss}
    >
      <div
        style={{
          background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)',
          padding: '32px', maxWidth: '400px', width: '100%', margin: '0 24px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {reason === 'subscription_past_due' ? (
          <>
            <h2 style={{ fontSize: '18px', fontWeight: 500, marginBottom: '12px' }}>Payment failed</h2>
            <p style={{ color: 'var(--color-muted)', marginBottom: '24px', fontSize: '14px' }}>
              Your payment didn't go through. Update your payment method to continue searching.
            </p>
            <button onClick={() => void fetch('/api/billing/portal', { method: 'POST' })
              .then(r => r.json())
              .then((d: { url: string }) => { window.location.href = d.url; })}>
              Update payment method →
            </button>
          </>
        ) : (
          <>
            <h2 style={{ fontSize: '18px', fontWeight: 500, marginBottom: '12px' }}>
              {plan === 'free' ? "You've used your 5 free searches" : "Monthly limit reached"}
            </h2>
            <p style={{ color: 'var(--color-muted)', marginBottom: '24px', fontSize: '14px' }}>
              {plan === 'free'
                ? 'Upgrade to Starter ($29/mo) for 50 searches per month.'
                : 'Upgrade your plan for more searches, or wait until your billing period resets.'}
            </p>
            <button
              onClick={() => router.push('/pricing')}
              style={{
                width: '100%', height: '44px',
                background: 'var(--color-info)', color: '#fff',
                border: 'none', borderRadius: 'var(--radius-default)',
                fontWeight: 500, cursor: 'pointer',
              }}
            >
              {plan === 'free' ? 'See pricing →' : 'Upgrade plan →'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
```

Update `web/lib/api.ts` `startSearch()` to throw a typed error on 402:

```typescript
export class PaywallError extends Error {
  constructor(
    public readonly reason: 'limit_reached' | 'subscription_past_due',
    public readonly plan: string
  ) {
    super('Search limit reached');
  }
}

export async function startSearch(address: string): Promise<{ runId: string }> {
  const res = await fetch('/api/web/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  const data = await res.json();
  if (res.status === 402) {
    throw new PaywallError(data.reason, data.plan);
  }
  if (!res.ok) throw new Error(data.error ?? 'Search failed');
  return data;
}
```

Update `SearchEmptyState.tsx` and `SearchBar.tsx` to catch `PaywallError` and show `<PaywallModal>`.

---

## Step 6 — Monthly reset cron

Search counts need to reset at the start of each billing period. Stripe's `invoice.payment_succeeded` event (Phase 3) already handles this for paid plans. For free plans, reset on the first of each month.

Add to `vercel.json` crons:

```json
{ "path": "/api/cron/reset-free-searches", "schedule": "0 0 1 * *" }
```

Create `api/cron/reset-free-searches.ts`:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { makeProvenanceStack } from '../../src/provenance/factory.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    res.status(401).end(); return;
  }
  const stack = await makeProvenanceStack();
  const { rowCount } = await stack.store.pool.query(
    `UPDATE users SET searches_used = 0 WHERE plan = 'free'`
  );
  res.status(200).json({ reset: rowCount });
}
```

---

## Step 7 — Admin: usage overview query

For your own visibility, here are the Neon SQL queries you'll run to understand usage:

```sql
-- Top users by searches this period
SELECT u.email, u.plan, u.searches_used, u.searches_limit,
       ROUND((u.searches_used::numeric / NULLIF(u.searches_limit,0)) * 100, 1) AS pct_used
FROM users u
ORDER BY u.searches_used DESC
LIMIT 20;

-- Daily search volume (last 30 days)
SELECT DATE(created_at) AS day, COUNT(*) AS searches,
       COUNT(*) FILTER (WHERE cached) AS cache_hits,
       COUNT(*) FILTER (WHERE credit_used) AS credits_consumed
FROM usage_events
WHERE created_at > NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 1 DESC;

-- Users approaching their limit (>80% used)
SELECT u.email, u.plan, u.searches_used, u.searches_limit
FROM users u
WHERE u.searches_used::numeric / NULLIF(u.searches_limit,0) > 0.8
  AND u.plan = 'free'
ORDER BY u.searches_used DESC;
-- These are your upgrade candidates — consider sending them an email (Phase 5)
```

---

## Definition of done

- [ ] Free users blocked after 5 searches with a clear upgrade prompt
- [ ] Cache hits never consume a credit
- [ ] `searches_used` increments atomically (no double-decrement possible)
- [ ] `usage_events` table has a row for every search (cached or not)
- [ ] `PaywallModal` appears when search returns 402
- [ ] Monthly reset cron runs on the 1st for free users
- [ ] Searches remaining shown in header
- [ ] `npm run lint` passes
