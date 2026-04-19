# Phase 7 — Analytics (PostHog)

**Goal:** Understand how people use Henry: where they drop off, which properties get searched most, what % of free users convert to paid, and whether the usage limiter actually drives upgrades. All data stays on servers you control (PostHog Cloud on EU servers, or self-hosted).

**Time estimate:** 1 day

**Prerequisite:** Phase 1 (users/auth working), Phase 2 (cache), Phase 4 (usage events)

**Tech:** PostHog v1 (JS SDK for browser), PostHog Node v4 (server-side events), Next.js integration

---

## Why PostHog over Google Analytics

- Captures individual user journeys, not just aggregate pageviews
- Session replay lets you watch actual user interactions (see where people get confused)
- Funnel analysis: signup → first search → hit limit → upgrade
- Feature flags: roll out new features to 10% of users first
- Open source: self-host on Vercel/Railway if you don't want PostHog Cloud
- No cookie consent banner required for PostHog's anonymized mode

---

## Step 1 — Create a PostHog account

1.1. Go to posthog.com → Create account → Choose "PostHog Cloud (US)" or "(EU)". EU is GDPR-friendlier.

1.2. Create a new project: "Henry Production".

1.3. Copy your Project API Key (starts with `phc_`) and the API host (e.g., `https://us.i.posthog.com`).

1.4. Add to `.env.example`:
```bash
NEXT_PUBLIC_POSTHOG_KEY=phc_...
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
POSTHOG_PERSONAL_API_KEY=phx_...  # for server-side, from PostHog Settings > Personal API Keys
```

---

## Step 2 — Install PostHog

```bash
npm install posthog-js@latest posthog-node@latest
```

---

## Step 3 — Browser-side PostHog provider

Create `web/components/PostHogProvider.tsx`:

```tsx
'use client';
import posthog from 'posthog-js';
import { PostHogProvider as PHProvider } from 'posthog-js/react';
import { useEffect } from 'react';
import { useUser } from '@clerk/nextjs';

function PostHogIdentify() {
  const { user } = useUser();

  useEffect(() => {
    if (user) {
      posthog.identify(user.id, {
        email: user.emailAddresses[0]?.emailAddress,
        name: user.fullName ?? undefined,
      });
    } else {
      posthog.reset();
    }
  }, [user]);

  return null;
}

export default function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      person_profiles: 'identified_only',   // no anonymous profiles (reduces noise + cost)
      capture_pageview: false,              // we'll do this manually per route
      capture_pageleave: true,
      session_recording: {
        maskAllInputs: true,               // don't record what users type (privacy)
        maskTextSelector: '[data-sensitive]', // add data-sensitive to PIN/owner fields
      },
    });
  }, []);

  return (
    <PHProvider client={posthog}>
      <PostHogIdentify />
      {children}
    </PHProvider>
  );
}
```

Wrap the app in `web/app/layout.tsx`:
```tsx
import PostHogProvider from '@/components/PostHogProvider';

// Inside ClerkProvider:
<ClerkProvider>
  <PostHogProvider>
    {children}
  </PostHogProvider>
</ClerkProvider>
```

---

## Step 4 — Pageview tracking

Next.js App Router doesn't fire a page change event on route transitions. Add a listener.

Create `web/components/PostHogPageview.tsx`:

```tsx
'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { usePostHog } from 'posthog-js/react';

export default function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const posthog = usePostHog();

  useEffect(() => {
    if (pathname) {
      let url = window.origin + pathname;
      if (searchParams.toString()) url += `?${searchParams.toString()}`;
      // Don't capture the full runId in the URL — it's not useful for analytics
      const cleanedUrl = url.replace(/\/property\/[^/]+/, '/property/[runId]');
      posthog.capture('$pageview', { $current_url: cleanedUrl });
    }
  }, [pathname, searchParams, posthog]);

  return null;
}
```

Add `<PostHogPageview />` inside `web/app/layout.tsx`, wrapped in `<Suspense>`.

---

## Step 5 — Server-side PostHog client

Create `src/lib/posthog.ts`:

```typescript
import { PostHog } from 'posthog-node';

let _client: PostHog | null = null;

export function getPostHogClient(): PostHog {
  if (!_client) {
    _client = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      flushAt: 1,      // flush immediately in serverless (no batching)
      flushInterval: 0,
    });
  }
  return _client;
}

/**
 * Fire a server-side event and await its flush.
 * Use in API routes where you want guaranteed delivery before the response closes.
 */
export async function captureServerEvent(
  distinctId: string,
  event: string,
  properties?: Record<string, unknown>
): Promise<void> {
  const ph = getPostHogClient();
  ph.capture({ distinctId, event, properties });
  await ph.flush();
}
```

---

## Step 6 — Key events to capture

Add these events to the appropriate handlers. Each event answers a specific business question.

**`search_started`** — in `api/web/search.ts`, after credit check passes:
```typescript
await captureServerEvent(user.id, 'search_started', {
  plan: user.plan,
  pin: property.pin,
  address: property.address,
  county: property.county,
  cached: false,
  searches_remaining: user.searchesLimit - user.searchesUsed,
});
```

**`search_cache_hit`** — in `api/web/search.ts`, when cache hit:
```typescript
await captureServerEvent(user.id, 'search_cache_hit', {
  plan: user.plan,
  pin: property.pin,
});
```

**`search_completed`** — in `runWebFanOut`, after `finishRun`:
```typescript
await captureServerEvent(recorder.invocation.userId ?? 'anonymous', 'search_completed', {
  run_id: recorder.runId,
  status: runStatus,
  duration_ms: durationMs,
  fetchers_completed: completedCount,
  fetchers_failed: failedCount,
  artifacts_count: artifactsCount,
});
```

**`search_blocked_limit`** — in `api/web/search.ts`, when 402 returned:
```typescript
await captureServerEvent(user.id, 'search_blocked_limit', {
  plan: user.plan,
  searches_used: user.searchesUsed,
  searches_limit: user.searchesLimit,
});
```

**`upgrade_clicked`** — in `web/app/pricing/page.tsx`, when a plan button is clicked:
```typescript
import { usePostHog } from 'posthog-js/react';
const posthog = usePostHog();
// Before the fetch:
posthog.capture('upgrade_clicked', { plan: planId, from_page: 'pricing' });
```

**`upgrade_completed`** — in `web/app/billing/success/page.tsx`:
```typescript
// On mount, after redirect back from Stripe:
posthog.capture('upgrade_completed', { plan: '...' }); // read plan from URL params or session
```

**`document_downloaded`** — in `web/components/DocumentsPanel.tsx`, on download button click:
```typescript
posthog.capture('document_downloaded', { label: artifact.label, content_type: artifact.contentType });
```

---

## Step 7 — PostHog dashboards to build

After a week of data, build these dashboards in PostHog:

**Funnel: Free → Paid**
1. `user_signed_up` (or use PostHog's built-in `$user_created`)
2. `search_started` (ran at least 1 search)
3. `search_blocked_limit` (hit the free limit)
4. `upgrade_clicked` (clicked a pricing plan)
5. `upgrade_completed` (Stripe checkout completed)

This funnel tells you where you're losing people. If you see many `search_blocked_limit` events but few `upgrade_clicked`, the paywall UX needs work.

**Retention: Are users coming back?**
- PostHog → Retention → "Did `search_started` in week 1 come back in week 2?"
- Target: >40% week-1 retention for paid users

**Top properties by search count**
- Use PostHog Insights → Breakdown by `pin` property of `search_started`
- Tells you which addresses are being researched most (useful for understanding your user base)

---

## Step 8 — Feature flags for safe rollouts

PostHog feature flags let you roll new features to a percentage of users before full release. Use this for Phase 8 (Vercel Queues migration) — roll to 10% of users first.

```typescript
// Server-side flag check (in API routes):
const ph = getPostHogClient();
const useQueues = await ph.isFeatureEnabled('use-vercel-queues', userId);

// Client-side flag check (in components):
import { useFeatureFlagEnabled } from 'posthog-js/react';
const useQueues = useFeatureFlagEnabled('use-vercel-queues');
```

---

## Definition of done

- [ ] PostHog initialized on every page load for authenticated users
- [ ] Users are `identify()`-ed with their Clerk user ID
- [ ] `search_started`, `search_completed`, `search_blocked_limit`, `upgrade_clicked`, `upgrade_completed` events firing
- [ ] Pageviews tracked on route transitions
- [ ] Session recording enabled (inputs masked)
- [ ] Free → Paid funnel built in PostHog
- [ ] `npm run lint` passes
