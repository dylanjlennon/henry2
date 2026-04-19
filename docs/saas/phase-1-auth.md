# Phase 1 — Auth (Clerk)

**Goal:** Every web user has an account. Searches are tied to a user identity, not an IP hash. Unauthenticated users can see the landing page but cannot run searches.

**Time estimate:** 2 days

**Prerequisite:** None — this is the foundation.

**Tech:** Clerk v6 (`@clerk/nextjs`), Neon Postgres (migration 004)

---

## Step 1 — Install Clerk from Vercel Marketplace

1.1. Go to vercel.com → your `henry-slack` project → Integrations tab → Browse Marketplace.

1.2. Search "Clerk" → click Install → follow the OAuth flow. Vercel will automatically add these env vars to your project (all environments):
```
CLERK_SECRET_KEY
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
```

1.3. Pull the new env vars locally:
```bash
vercel env pull .env.local
```

1.4. Verify both keys are now in `.env.local`.

---

## Step 2 — Install Clerk SDK

```bash
npm install @clerk/nextjs@latest
```

Verify the installed version is v6+:
```bash
npm ls @clerk/nextjs
```

---

## Step 3 — Add Clerk middleware

Create `web/middleware.ts` (Next.js middleware must live at the root of the `web/` app directory or alongside `app/`):

```typescript
// web/middleware.ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',                    // landing page
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/web/config',      // Google Places key — no auth needed
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
};
```

This protects every route except the landing page and sign-in/sign-up pages. The `/api/web/search` route will now require a valid Clerk session.

---

## Step 4 — Wrap the Next.js app with ClerkProvider

Edit `web/app/layout.tsx`:

```typescript
// web/app/layout.tsx
import { ClerkProvider } from '@clerk/nextjs';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
```

---

## Step 5 — Add sign-in and sign-up pages

Create `web/app/sign-in/[[...sign-in]]/page.tsx`:

```typescript
import { SignIn } from '@clerk/nextjs';

export default function SignInPage() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: 'var(--color-canvas)' }}>
      <SignIn
        appearance={{
          elements: {
            rootBox: { fontFamily: 'inherit' },
            card: { boxShadow: 'none', border: '1px solid var(--color-rule)' },
          }
        }}
        afterSignInUrl="/search"
        signUpUrl="/sign-up"
      />
    </div>
  );
}
```

Create `web/app/sign-up/[[...sign-up]]/page.tsx`:

```typescript
import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', background: 'var(--color-canvas)' }}>
      <SignUp
        appearance={{
          elements: {
            rootBox: { fontFamily: 'inherit' },
            card: { boxShadow: 'none', border: '1px solid var(--color-rule)' },
          }
        }}
        afterSignUpUrl="/search"
        signInUrl="/sign-in"
      />
    </div>
  );
}
```

---

## Step 6 — Move the search UI to /search route

Right now `/` IS the search tool. After auth, `/` becomes the landing/marketing page and the actual search app lives at `/search`.

6.1. Create `web/app/search/page.tsx` — copy the current content of `web/app/page.tsx` into it.

6.2. Rewrite `web/app/page.tsx` to be the marketing landing page (see Phase 6 for full content — for now, a placeholder with a "Get started" button pointing to `/sign-up` is fine).

6.3. Update `SearchEmptyState.tsx` — the history redirect and `router.push` calls already point to `/property/[runId]`, no changes needed there.

---

## Step 7 — Add a UserButton to the app header

Edit `web/app/layout.tsx` to show the Clerk `<UserButton>` in the header for authenticated users:

```typescript
import { ClerkProvider, SignedIn, SignedOut, SignInButton, UserButton } from '@clerk/nextjs';

// In the header JSX:
<header>
  <div>Henry<span style={{ color: 'var(--color-info)' }}>.</span></div>
  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-muted)' }}>Buncombe County, NC</span>
    <SignedIn>
      <UserButton afterSignOutUrl="/" />
    </SignedIn>
    <SignedOut>
      <SignInButton mode="modal">
        <button style={{ /* same button style as existing site */ }}>Sign in</button>
      </SignInButton>
    </SignedOut>
  </div>
</header>
```

---

## Step 8 — Database migration: users table + invocations.user_id

Create `src/provenance/migrations/004_users.sql`:

```sql
-- Henry provenance schema, migration 004.
-- Adds user identity tracking for SaaS billing and usage metering.

CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clerk_id              TEXT NOT NULL UNIQUE,      -- Clerk's user ID (user_xxxxxx)
  email                 TEXT NOT NULL,
  plan                  TEXT NOT NULL DEFAULT 'free'
                          CHECK (plan IN ('free', 'starter', 'pro', 'team')),
  stripe_customer_id    TEXT,
  stripe_subscription_id TEXT,
  subscription_status   TEXT,                       -- 'active', 'canceled', 'past_due', etc.
  searches_used         INTEGER NOT NULL DEFAULT 0, -- resets each billing period
  searches_limit        INTEGER NOT NULL DEFAULT 5, -- 5 for free, set on plan change
  period_start          TIMESTAMPTZ,
  period_end            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_clerk_id_idx ON users (clerk_id);
CREATE INDEX IF NOT EXISTS users_stripe_customer_id_idx ON users (stripe_customer_id);
CREATE INDEX IF NOT EXISTS users_stripe_subscription_id_idx ON users (stripe_subscription_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_users_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at_trigger
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION update_users_updated_at();

-- Link invocations to users (nullable — Slack invocations have no user_id)
ALTER TABLE invocations ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS invocations_user_id_idx ON invocations (user_id, created_at DESC);
```

Run migration:
```bash
# From project root, using the same pattern as migration 003
node --input-type=module << 'EOF'
import pg from './node_modules/pg/lib/index.js';
import { readFileSync } from 'fs';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await pool.query(readFileSync('src/provenance/migrations/004_users.sql', 'utf8'));
console.log('Migration 004 applied');
await pool.end();
EOF
```

---

## Step 9 — Create/fetch user record on first search

Add a user sync utility at `src/lib/userSync.ts`:

```typescript
// src/lib/userSync.ts
import type { Pool } from 'pg';

export interface UserRecord {
  id: string;
  clerkId: string;
  email: string;
  plan: string;
  searchesUsed: number;
  searchesLimit: number;
  stripeCustomerId: string | null;
}

/**
 * Upsert a user row from Clerk identity data.
 * Called on every authenticated search to ensure the row exists
 * and to return current plan state.
 */
export async function getOrCreateUser(
  pool: Pool,
  clerk: { userId: string; email: string }
): Promise<UserRecord> {
  const { rows } = await pool.query<{
    id: string; clerk_id: string; email: string; plan: string;
    searches_used: number; searches_limit: number; stripe_customer_id: string | null;
  }>(
    `INSERT INTO users (clerk_id, email)
     VALUES ($1, $2)
     ON CONFLICT (clerk_id) DO UPDATE SET
       email = EXCLUDED.email,
       updated_at = NOW()
     RETURNING id, clerk_id, email, plan, searches_used, searches_limit, stripe_customer_id`,
    [clerk.userId, clerk.email]
  );
  const r = rows[0];
  return {
    id: r.id,
    clerkId: r.clerk_id,
    email: r.email,
    plan: r.plan,
    searchesUsed: r.searches_used,
    searchesLimit: r.searches_limit,
    stripeCustomerId: r.stripe_customer_id,
  };
}
```

---

## Step 10 — Thread Clerk auth into the search API handler

Update `api/web/search.ts` to:
1. Read the Clerk session from the request
2. Get or create the user record
3. Attach `userId` to the invocation

```typescript
// Add to imports at top of api/web/search.ts
import { getAuth } from '@clerk/nextjs/server';

// Inside the handler, after rate limit check:
const { userId: clerkUserId } = getAuth(req);
if (!clerkUserId) {
  res.status(401).json({ error: 'Authentication required' });
  return;
}

// Get the user's email from Clerk (for the users table)
// Import createClerkClient for server-side user lookup
import { createClerkClient } from '@clerk/backend';
const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const clerkUser = await clerkClient.users.getUser(clerkUserId);
const email = clerkUser.emailAddresses[0]?.emailAddress ?? '';

// Get or create user row
const { getOrCreateUser } = await import('../../src/lib/userSync.js');
const user = await getOrCreateUser(stack.store.pool, { userId: clerkUserId, email });

// Attach userId to invocation
const invocation: Invocation = {
  // ... existing fields ...
  userId: user.id,   // add this to the Invocation schema in Step 11
};
```

---

## Step 11 — Add userId to Invocation schema

Update `src/provenance/schema.ts` — add `userId` to the `Invocation` zod object:

```typescript
export const Invocation = z.object({
  // ... existing fields ...
  ipHash: z.string().nullable().optional(),
  metadata: InvocationMetadata,
  userId: z.string().uuid().nullable().optional(),  // add this line
});
```

Update `src/provenance/postgresStore.ts` `saveInvocation` — add `user_id` to the INSERT:

```typescript
// Add to the INSERT column list: ..., user_id
// Add to VALUES: ..., $12
// Add to ON CONFLICT UPDATE: user_id = EXCLUDED.user_id
// Add to params array: inv.userId ?? null
```

---

## Step 12 — Add Clerk env vars to .env.example

Update `.env.example`:
```bash
# Clerk auth
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/sign-in
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/sign-up
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/search
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/search
```

Also add these to `web/.env.local` (or the root `.env.local` if vercel dev serves both).

---

## Step 13 — Verify everything works

13.1. Run `npm run lint` — should pass with zero errors.

13.2. Run `vercel dev` locally. Navigate to `/search`. You should be redirected to `/sign-in`.

13.3. Sign up with your own email. After signup you should land on `/search` and be able to run a search.

13.4. Check Neon: `SELECT * FROM users LIMIT 5;` — you should see your user row.

13.5. Check `SELECT user_id FROM invocations ORDER BY created_at DESC LIMIT 3;` — should show your user UUID.

---

## Rollback plan

If something breaks in production:
1. In Vercel project settings → Environment Variables, temporarily set `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` to empty string — this breaks ClerkProvider but leaves the app loadable
2. Revert `web/middleware.ts` to have no protection (make all routes public)
3. The DB changes are additive and non-breaking — no rollback needed for migrations

---

## Definition of done

- [ ] Users can sign up and sign in via email or Google
- [ ] Unauthenticated requests to `/api/web/search` return 401
- [ ] Every search creates a row in `users` and links to `invocations.user_id`
- [ ] UserButton appears in header when signed in
- [ ] `npm run lint` passes
- [ ] `npm run test` passes
