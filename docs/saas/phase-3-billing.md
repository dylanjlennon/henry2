# Phase 3 — Billing (Stripe)

**Goal:** Users can subscribe to a paid plan. Stripe handles payment, invoicing, and renewals. Henry's database stays in sync with Stripe's subscription state via webhooks.

**Time estimate:** 2 days

**Prerequisite:** Phase 1 (users table exists, Clerk auth working)

**Tech:** Stripe Billing, `stripe` Node SDK v17, Stripe Checkout (embedded), webhooks

---

## Step 1 — Set up Stripe account and products

1.1. Create a Stripe account at stripe.com if you don't have one. Enable Stripe Tax if you plan to charge sales tax (relevant for SaaS in some US states — consult an accountant).

1.2. In the Stripe Dashboard → Products, create the following products and prices. Do this in **test mode first**.

**Product: Henry Starter**
- Price: $29.00/month, recurring
- Metadata key `plan`: `starter`
- Metadata key `searches_limit`: `50`

**Product: Henry Pro**
- Price: $99.00/month, recurring
- Metadata key `plan`: `pro`
- Metadata key `searches_limit`: `250`

**Product: Henry Team**
- Price: $249.00/month, recurring
- Metadata key `plan`: `team`
- Metadata key `searches_limit`: `1000`

1.3. Copy the Price IDs (start with `price_`) for each plan — you'll need them in the next step.

1.4. Create a Customer Portal configuration: Stripe Dashboard → Billing → Customer Portal. Enable "Cancel subscription" and "Update payment method." Save the portal link for later.

---

## Step 2 — Install Stripe SDK

```bash
npm install stripe@latest
npm install @stripe/stripe-js@latest   # client-side only if you use Stripe Elements
```

---

## Step 3 — Add Stripe env vars

Add to `.env.example`:
```bash
# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...

# Stripe Price IDs (copy from Stripe Dashboard)
STRIPE_PRICE_STARTER=price_...
STRIPE_PRICE_PRO=price_...
STRIPE_PRICE_TEAM=price_...
```

Add all of these to your Vercel project via `vercel env add` for each environment (development, preview, production). Use test-mode keys for development/preview, live keys for production only.

---

## Step 4 — Create a shared Stripe client

Create `src/lib/stripe.ts`:

```typescript
import Stripe from 'stripe';

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2025-01-27.acacia',  // pin to the latest stable API version
  typescript: true,
});

export const PLAN_PRICE_IDS: Record<string, string> = {
  starter: process.env.STRIPE_PRICE_STARTER!,
  pro: process.env.STRIPE_PRICE_PRO!,
  team: process.env.STRIPE_PRICE_TEAM!,
};

export const PLAN_SEARCH_LIMITS: Record<string, number> = {
  free: 5,
  starter: 50,
  pro: 250,
  team: 1000,
};
```

---

## Step 5 — Checkout session API route

Create `api/billing/checkout.ts`:

```typescript
/**
 * POST /api/billing/checkout
 * Body: { plan: 'starter' | 'pro' | 'team' }
 * Returns: { url: string } — redirect user to this URL to complete payment
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAuth } from '@clerk/nextjs/server';
import { createClerkClient } from '@clerk/backend';
import { stripe, PLAN_PRICE_IDS } from '../../src/lib/stripe.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { getOrCreateUser } from '../../src/lib/userSync.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const { plan } = req.body as { plan: string };
  const priceId = PLAN_PRICE_IDS[plan];
  if (!priceId) { res.status(400).json({ error: 'Unknown plan' }); return; }

  const clerkClient = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  const email = clerkUser.emailAddresses[0]?.emailAddress ?? '';

  const stack = await makeProvenanceStack();
  const user = await getOrCreateUser(stack.store.pool, { userId: clerkUserId, email });

  // Ensure Stripe customer exists
  let customerId = user.stripeCustomerId;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email,
      metadata: { clerk_id: clerkUserId, henry_user_id: user.id },
    });
    customerId = customer.id;
    await stack.store.pool.query(
      `UPDATE users SET stripe_customer_id = $1 WHERE id = $2`,
      [customerId, user.id]
    );
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? `https://${process.env.VERCEL_URL}`;

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${baseUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/pricing`,
    subscription_data: {
      metadata: { plan, henry_user_id: user.id },
    },
    allow_promotion_codes: true,
    automatic_tax: { enabled: false }, // enable when you have tax configured
  });

  res.status(200).json({ url: session.url });
}
```

---

## Step 6 — Stripe webhook handler

This is the most critical piece — Stripe tells you when a subscription is created, renewed, or canceled. You must handle these events to keep your DB in sync.

Create `api/billing/webhook.ts`:

```typescript
/**
 * POST /api/billing/webhook
 * Stripe sends signed events here. Verifies signature before processing.
 * Must be an unauthenticated route (Clerk middleware must exclude it).
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { stripe, PLAN_SEARCH_LIMITS } from '../../src/lib/stripe.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { log } from '../../src/lib/log.js';
import type Stripe from 'stripe';

// Vercel parses the body by default — we need the raw bytes for signature verification.
// Add this to vercel.json under "functions":
// "api/billing/webhook.ts": { "bodyParser": false }
export const config = { api: { bodyParser: false } };

async function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const sig = req.headers['stripe-signature'] as string;
  const rawBody = await getRawBody(req);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    log.warn('stripe_webhook_invalid_signature', { err: String(err) });
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  const stack = await makeProvenanceStack();
  const pool = stack.store.pool;

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session;
        if (session.mode !== 'subscription') break;
        const sub = await stripe.subscriptions.retrieve(session.subscription as string);
        await syncSubscription(pool, sub);
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.created': {
        const sub = event.data.object as Stripe.Subscription;
        await syncSubscription(pool, sub);
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        await pool.query(
          `UPDATE users SET
             plan = 'free',
             stripe_subscription_id = NULL,
             subscription_status = 'canceled',
             searches_limit = $1,
             period_start = NULL,
             period_end = NULL
           WHERE stripe_customer_id = $2`,
          [PLAN_SEARCH_LIMITS.free, sub.customer as string]
        );
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice;
        await pool.query(
          `UPDATE users SET subscription_status = 'past_due'
           WHERE stripe_customer_id = $1`,
          [invoice.customer as string]
        );
        break;
      }

      case 'invoice.payment_succeeded': {
        // New billing period — reset the search counter
        const invoice = event.data.object as Stripe.Invoice;
        if (invoice.billing_reason === 'subscription_cycle' || invoice.billing_reason === 'subscription_create') {
          await pool.query(
            `UPDATE users SET searches_used = 0, subscription_status = 'active'
             WHERE stripe_customer_id = $1`,
            [invoice.customer as string]
          );
        }
        break;
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    log.error('stripe_webhook_handler_error', { type: event.type, err: String(err) });
    res.status(500).json({ error: 'Handler error' });
  }
}

async function syncSubscription(pool: import('pg').Pool, sub: Stripe.Subscription) {
  const plan = (sub.metadata.plan ?? 'free') as string;
  const limit = PLAN_SEARCH_LIMITS[plan] ?? PLAN_SEARCH_LIMITS.free;
  const currentPeriodStart = new Date(sub.current_period_start * 1000).toISOString();
  const currentPeriodEnd = new Date(sub.current_period_end * 1000).toISOString();

  await pool.query(
    `UPDATE users SET
       plan = $1,
       stripe_subscription_id = $2,
       subscription_status = $3,
       searches_limit = $4,
       period_start = $5,
       period_end = $6
     WHERE stripe_customer_id = $7`,
    [plan, sub.id, sub.status, limit, currentPeriodStart, currentPeriodEnd, sub.customer as string]
  );
}
```

Update `vercel.json` to disable body parser for the webhook route:

```json
{
  "functions": {
    "api/billing/webhook.ts": { "bodyParser": false }
  }
}
```

---

## Step 7 — Register webhook in Stripe Dashboard

7.1. Go to Stripe Dashboard → Webhooks → Add endpoint.

7.2. Endpoint URL: `https://henry-slack.vercel.app/api/billing/webhook`

7.3. Select these events to listen for:
- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.payment_failed`
- `invoice.payment_succeeded`

7.4. Copy the webhook signing secret (`whsec_...`) and add it as `STRIPE_WEBHOOK_SECRET` in Vercel env vars.

7.5. For local development, install the Stripe CLI:
```bash
brew install stripe/stripe-cli/stripe
stripe login
stripe listen --forward-to localhost:3000/api/billing/webhook
```
This gives you a local webhook signing secret for `.env.local`.

---

## Step 8 — Customer Portal API route

Let users manage their own subscription (upgrade, downgrade, cancel, update payment method) via Stripe's hosted portal. This saves you building any of that UI yourself.

Create `api/billing/portal.ts`:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getAuth } from '@clerk/nextjs/server';
import { stripe } from '../../src/lib/stripe.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return; }
  const { userId: clerkUserId } = getAuth(req);
  if (!clerkUserId) { res.status(401).end(); return; }

  const stack = await makeProvenanceStack();
  const { rows } = await stack.store.pool.query(
    `SELECT stripe_customer_id FROM users WHERE clerk_id = $1`,
    [clerkUserId]
  );
  const customerId = rows[0]?.stripe_customer_id;
  if (!customerId) { res.status(400).json({ error: 'No billing account found' }); return; }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? `https://${process.env.VERCEL_URL}`;
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${baseUrl}/account`,
  });

  res.status(200).json({ url: session.url });
}
```

---

## Step 9 — Pricing page and upgrade flow in the UI

Create `web/app/pricing/page.tsx` — a simple three-column pricing table:

```typescript
'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@clerk/nextjs';

const PLANS = [
  {
    id: 'starter',
    name: 'Starter',
    price: '$29',
    searches: '50 searches/month',
    features: ['All 12 data sources', 'All documents as PDFs', '24-hr result cache', 'Search history'],
  },
  {
    id: 'pro',
    name: 'Pro',
    price: '$99',
    searches: '250 searches/month',
    features: ['Everything in Starter', 'Priority support', 'API access (coming soon)'],
    recommended: true,
  },
  {
    id: 'team',
    name: 'Team',
    price: '$249',
    searches: '1,000 searches/month',
    features: ['Everything in Pro', 'Shared history (coming soon)', 'Slack integration included'],
  },
];

export default function PricingPage() {
  const { isSignedIn } = useAuth();
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);

  const handleSelect = async (planId: string) => {
    if (!isSignedIn) { router.push('/sign-up'); return; }
    setLoading(planId);
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan: planId }),
    });
    const { url } = await res.json() as { url: string };
    window.location.href = url;
  };

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '60px 24px' }}>
      <h1 style={{ textAlign: 'center', fontSize: '32px', fontWeight: 500, marginBottom: '48px' }}>
        Simple, transparent pricing
      </h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
        {PLANS.map((plan) => (
          <div key={plan.id} style={{
            border: plan.recommended ? '2px solid var(--color-info)' : '1px solid var(--color-rule)',
            borderRadius: 'var(--radius-lg)',
            padding: '28px',
            background: 'var(--color-surface)',
            position: 'relative',
          }}>
            {plan.recommended && (
              <div style={{ position: 'absolute', top: '-12px', left: '50%', transform: 'translateX(-50%)',
                background: 'var(--color-info)', color: '#fff', fontSize: '11px', fontWeight: 600,
                letterSpacing: '0.05em', textTransform: 'uppercase', padding: '3px 12px',
                borderRadius: 'var(--radius-pill)' }}>
                Most popular
              </div>
            )}
            <div style={{ fontSize: '18px', fontWeight: 500, marginBottom: '4px' }}>{plan.name}</div>
            <div style={{ fontSize: '32px', fontWeight: 600, marginBottom: '4px' }}>{plan.price}<span style={{ fontSize: '14px', color: 'var(--color-muted)' }}>/mo</span></div>
            <div style={{ fontSize: '13px', color: 'var(--color-muted)', marginBottom: '20px' }}>{plan.searches}</div>
            <ul style={{ listStyle: 'none', padding: 0, marginBottom: '24px' }}>
              {plan.features.map((f) => (
                <li key={f} style={{ fontSize: '14px', padding: '4px 0', color: 'var(--color-ink)' }}>✓ {f}</li>
              ))}
            </ul>
            <button
              onClick={() => void handleSelect(plan.id)}
              disabled={loading === plan.id}
              style={{
                width: '100%', height: '40px',
                background: plan.recommended ? 'var(--color-info)' : 'var(--color-surface)',
                color: plan.recommended ? '#fff' : 'var(--color-ink)',
                border: plan.recommended ? 'none' : '1px solid var(--color-rule)',
                borderRadius: 'var(--radius-default)',
                fontWeight: 500, cursor: 'pointer',
                opacity: loading === plan.id ? 0.6 : 1,
              }}
            >
              {loading === plan.id ? 'Redirecting…' : 'Get started'}
            </button>
          </div>
        ))}
      </div>
      <p style={{ textAlign: 'center', marginTop: '32px', color: 'var(--color-muted)', fontSize: '13px' }}>
        5 free searches/month on every account · No credit card required to start
      </p>
    </div>
  );
}
```

---

## Step 10 — Account page with billing portal link

Create `web/app/account/page.tsx`:

```typescript
'use client';
import { useUser } from '@clerk/nextjs';

export default function AccountPage() {
  const { user } = useUser();

  const openPortal = async () => {
    const res = await fetch('/api/billing/portal', { method: 'POST' });
    const { url } = await res.json() as { url: string };
    window.location.href = url;
  };

  return (
    <div style={{ maxWidth: '560px', margin: '60px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 500, marginBottom: '24px' }}>Account</h1>
      <p style={{ color: 'var(--color-muted)' }}>{user?.emailAddresses[0]?.emailAddress}</p>
      <button onClick={() => void openPortal()} style={{ marginTop: '16px', /* button styles */ }}>
        Manage subscription & billing →
      </button>
    </div>
  );
}
```

---

## Step 11 — Test the full billing flow

11.1. Use Stripe test card `4242 4242 4242 4242`, any future date, any CVC.

11.2. Subscribe to Starter. Verify:
- Stripe Dashboard shows the subscription as active
- `users` row has `plan='starter'`, `searches_limit=50`, `subscription_status='active'`
- `stripe_subscription_id` is populated

11.3. Use the Customer Portal to cancel. Verify:
- `users` row updates to `plan='free'`, `searches_limit=5` after webhook fires

11.4. Check webhook logs in Stripe Dashboard to confirm all events are being received and processed.

11.5. Test `invoice.payment_failed` using Stripe test card `4000 0000 0000 0341`.

---

## Definition of done

- [ ] Users can subscribe to Starter/Pro/Team via Stripe Checkout
- [ ] Webhook correctly updates `users.plan` and `users.searches_limit` on all subscription events
- [ ] Canceled subscriptions revert to free tier
- [ ] Payment failures set `subscription_status = 'past_due'`
- [ ] Billing period renewal resets `searches_used` to 0
- [ ] Customer Portal link works for managing/canceling subscription
- [ ] Full flow tested with Stripe test cards
- [ ] `npm run lint` passes
