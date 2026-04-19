# Phase 5 — Transactional Email (Resend + React Email)

**Goal:** Users receive emails at key moments: welcome on signup, receipt after subscribing, warning when approaching their limit, and confirmation when they cancel. These emails are functional, not marketing — they build trust and reduce churn.

**Time estimate:** 1 day

**Prerequisite:** Phase 1 (users table), Phase 3 (Stripe subscription events)

**Tech:** Resend v4, React Email, triggered from Stripe webhook events and Clerk webhook

---

## Step 1 — Set up Resend

1.1. Create an account at resend.com.

1.2. Add your domain: Resend → Domains → Add Domain → enter your sending domain (e.g., `henry.yourdomain.com` or just `yourdomain.com`). Follow the DNS verification steps (adds SPF, DKIM, DMARC records). This is required for non-spam deliverability.

1.3. Until your domain is verified, you can send to your own email using `onboarding@resend.dev` as the from address. Don't use this in production.

1.4. Create an API key: Resend → API Keys → Create API Key → Full access.

1.5. Add to `.env.example`:
```bash
RESEND_API_KEY=re_...
EMAIL_FROM=Henry <noreply@yourdomain.com>
```

Add both to Vercel env vars.

---

## Step 2 — Install dependencies

```bash
npm install resend@latest @react-email/components@latest
```

---

## Step 3 — Create a shared email client

Create `src/lib/email.ts`:

```typescript
import { Resend } from 'resend';

export const resend = new Resend(process.env.RESEND_API_KEY);
export const FROM = process.env.EMAIL_FROM ?? 'Henry <noreply@example.com>';
```

---

## Step 4 — Email templates with React Email

Create `src/emails/` directory. Each template is a React component that renders to HTML.

**`src/emails/WelcomeEmail.tsx`:**

```tsx
import {
  Body, Button, Container, Head, Heading, Html,
  Preview, Section, Text, Hr,
} from '@react-email/components';

interface WelcomeEmailProps {
  firstName?: string;
}

export default function WelcomeEmail({ firstName }: WelcomeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>Welcome to Henry — your Buncombe County property research tool</Preview>
      <Body style={{ fontFamily: 'system-ui, sans-serif', background: '#f8f9fa', padding: '40px 0' }}>
        <Container style={{ background: '#fff', borderRadius: '8px', padding: '40px', maxWidth: '520px', margin: '0 auto' }}>
          <Heading style={{ fontSize: '22px', fontWeight: 600, marginBottom: '8px' }}>
            Welcome{firstName ? `, ${firstName}` : ''}.
          </Heading>
          <Text style={{ color: '#4a5568', lineHeight: '1.6' }}>
            Henry pulls every public record on any Buncombe County property — deed, tax bill, flood map,
            permits, soil data, landslide risk — and delivers them in under 2 minutes.
          </Text>
          <Text style={{ color: '#4a5568' }}>
            You have <strong>5 free searches</strong> to start. No credit card needed.
          </Text>
          <Section style={{ textAlign: 'center', margin: '32px 0' }}>
            <Button
              href="https://henry-web-inky.vercel.app/search"
              style={{
                background: '#1F6DA6', color: '#fff', borderRadius: '6px',
                padding: '12px 28px', fontWeight: 600, textDecoration: 'none',
              }}
            >
              Search your first property →
            </Button>
          </Section>
          <Hr style={{ borderColor: '#e2e8f0' }} />
          <Text style={{ fontSize: '12px', color: '#a0aec0', textAlign: 'center' }}>
            Henry · Buncombe County, NC · You're receiving this because you signed up at henry-web-inky.vercel.app
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
```

**`src/emails/SubscriptionConfirmedEmail.tsx`:**

```tsx
import { Body, Container, Head, Heading, Html, Preview, Text, Hr } from '@react-email/components';

interface Props {
  plan: string;
  searchesLimit: number;
  periodEnd: string; // e.g. "May 1, 2026"
  amount: string;    // e.g. "$29.00"
}

export default function SubscriptionConfirmedEmail({ plan, searchesLimit, periodEnd, amount }: Props) {
  const planDisplay = plan.charAt(0).toUpperCase() + plan.slice(1);
  return (
    <Html>
      <Head />
      <Preview>Henry {planDisplay} — subscription confirmed</Preview>
      <Body style={{ fontFamily: 'system-ui, sans-serif', background: '#f8f9fa', padding: '40px 0' }}>
        <Container style={{ background: '#fff', borderRadius: '8px', padding: '40px', maxWidth: '520px', margin: '0 auto' }}>
          <Heading style={{ fontSize: '22px', fontWeight: 600 }}>
            You're on Henry {planDisplay}.
          </Heading>
          <Text style={{ color: '#4a5568' }}>
            You now have <strong>{searchesLimit} searches/month</strong>. Your next billing date is {periodEnd} ({amount}).
          </Text>
          <Text style={{ color: '#4a5568' }}>
            Manage your subscription any time from your account page.
          </Text>
          <Hr style={{ borderColor: '#e2e8f0' }} />
          <Text style={{ fontSize: '12px', color: '#a0aec0', textAlign: 'center' }}>Henry · Buncombe County, NC</Text>
        </Container>
      </Body>
    </Html>
  );
}
```

**`src/emails/LimitWarningEmail.tsx`:**

```tsx
import { Body, Button, Container, Head, Heading, Html, Preview, Text } from '@react-email/components';

interface Props {
  searchesUsed: number;
  searchesLimit: number;
  plan: string;
}

export default function LimitWarningEmail({ searchesUsed, searchesLimit, plan }: Props) {
  const remaining = searchesLimit - searchesUsed;
  return (
    <Html>
      <Head />
      <Preview>{remaining} searches left this month on Henry</Preview>
      <Body style={{ fontFamily: 'system-ui, sans-serif', background: '#f8f9fa', padding: '40px 0' }}>
        <Container style={{ background: '#fff', borderRadius: '8px', padding: '40px', maxWidth: '520px', margin: '0 auto' }}>
          <Heading style={{ fontSize: '22px', fontWeight: 600 }}>
            {remaining} search{remaining === 1 ? '' : 'es'} left this month.
          </Heading>
          <Text style={{ color: '#4a5568' }}>
            You've used {searchesUsed} of your {searchesLimit} searches for {plan === 'free' ? 'your free account' : `your ${plan} plan`}.
          </Text>
          {plan === 'free' && (
            <>
              <Text style={{ color: '#4a5568' }}>
                Upgrade to Starter for $29/month and get 50 searches — enough for an active month of property research.
              </Text>
              <Button
                href="https://henry-web-inky.vercel.app/pricing"
                style={{ background: '#1F6DA6', color: '#fff', borderRadius: '6px', padding: '12px 28px', fontWeight: 600, textDecoration: 'none' }}
              >
                Upgrade now →
              </Button>
            </>
          )}
        </Container>
      </Body>
    </Html>
  );
}
```

---

## Step 5 — Email sending functions

Create `src/lib/sendEmail.ts`:

```typescript
import { resend, FROM } from './email.js';
import { render } from '@react-email/render';
import WelcomeEmail from '../emails/WelcomeEmail.js';
import SubscriptionConfirmedEmail from '../emails/SubscriptionConfirmedEmail.js';
import LimitWarningEmail from '../emails/LimitWarningEmail.js';
import { log } from './log.js';

async function send(to: string, subject: string, html: string) {
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    log.error('email_send_failed', { to, subject, err: String(err) });
    // Non-fatal — log and continue
  }
}

export async function sendWelcomeEmail(to: string, firstName?: string) {
  const html = await render(WelcomeEmail({ firstName }));
  await send(to, 'Welcome to Henry', html);
}

export async function sendSubscriptionConfirmedEmail(to: string, opts: {
  plan: string; searchesLimit: number; periodEnd: string; amount: string;
}) {
  const html = await render(SubscriptionConfirmedEmail(opts));
  const planDisplay = opts.plan.charAt(0).toUpperCase() + opts.plan.slice(1);
  await send(to, `Henry ${planDisplay} — subscription confirmed`, html);
}

export async function sendLimitWarningEmail(to: string, opts: {
  searchesUsed: number; searchesLimit: number; plan: string;
}) {
  const html = await render(LimitWarningEmail(opts));
  await send(to, `${opts.searchesLimit - opts.searchesUsed} searches left this month on Henry`, html);
}
```

---

## Step 6 — Trigger emails from the right places

**Welcome email — triggered by Clerk webhook:**

Set up a Clerk webhook (Clerk Dashboard → Webhooks → Add endpoint):
- URL: `https://henry-slack.vercel.app/api/clerk/webhook`
- Events: `user.created`

Create `api/clerk/webhook.ts`:

```typescript
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Webhook } from 'svix';  // npm install svix
import { sendWelcomeEmail } from '../../src/lib/sendEmail.js';

export const config = { api: { bodyParser: false } };

async function getRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  const body = await getRawBody(req);
  const wh = new Webhook(process.env.CLERK_WEBHOOK_SECRET!);

  let evt: { type: string; data: { email_addresses: Array<{ email_address: string }>; first_name?: string } };
  try {
    evt = wh.verify(body, {
      'svix-id': req.headers['svix-id'] as string,
      'svix-timestamp': req.headers['svix-timestamp'] as string,
      'svix-signature': req.headers['svix-signature'] as string,
    }) as typeof evt;
  } catch {
    res.status(400).json({ error: 'Invalid signature' }); return;
  }

  if (evt.type === 'user.created') {
    const email = evt.data.email_addresses[0]?.email_address;
    const firstName = evt.data.first_name;
    if (email) await sendWelcomeEmail(email, firstName);
  }

  res.status(200).json({ received: true });
}
```

Add `CLERK_WEBHOOK_SECRET` to env vars (from Clerk Dashboard after creating the webhook).
Add `svix` to dependencies: `npm install svix`.

**Subscription confirmed email — add to Stripe webhook handler** (Phase 3, `api/billing/webhook.ts`):

In the `checkout.session.completed` case, after `syncSubscription`:

```typescript
// Get user email to send confirmation
const { rows } = await pool.query<{ email: string }>(
  `SELECT u.email FROM users u WHERE u.stripe_customer_id = $1`,
  [session.customer as string]
);
if (rows[0]) {
  const sub = await stripe.subscriptions.retrieve(session.subscription as string);
  const periodEnd = new Date(sub.current_period_end * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const invoice = await stripe.invoices.retrieve(session.invoice as string);
  const amount = `$${((invoice.amount_paid ?? 0) / 100).toFixed(2)}`;
  const plan = sub.metadata.plan ?? 'starter';
  const limit = PLAN_SEARCH_LIMITS[plan] ?? 50;
  await sendSubscriptionConfirmedEmail(rows[0].email, { plan, searchesLimit: limit, periodEnd, amount });
}
```

**Limit warning email — triggered from the credit check** (Phase 4, `src/lib/credits.ts`):

In `consumeCredit`, after the update, check if the user just hit 80% of their limit and send a warning if so (send at most once — add a `limit_warning_sent_at` column to `users` to avoid spam):

```typescript
// After successful UPDATE in consumeCredit:
const { searches_used, searches_limit, email, plan, limit_warning_sent_at } = rows[0];
const pct = searches_used / searches_limit;

// Send warning at 80% used, but only once per billing period
if (pct >= 0.8 && !limit_warning_sent_at) {
  await pool.query(`UPDATE users SET limit_warning_sent_at = NOW() WHERE id = $1`, [userId]);
  // Import and call sendLimitWarningEmail (use setImmediate to not block the search response)
  setImmediate(() => {
    void sendLimitWarningEmail(email, { searchesUsed: searches_used, searchesLimit: searches_limit, plan });
  });
}
```

Add `limit_warning_sent_at TIMESTAMPTZ` column to `users` table in migration 006 or a new migration 007:
```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS limit_warning_sent_at TIMESTAMPTZ;
```

Reset this column to NULL in the monthly reset cron and in `syncSubscription` (when a new billing period starts).

---

## Step 7 — Preview emails locally

React Email has a local preview server:

```bash
npx email dev --dir src/emails --port 3001
```

Navigate to `http://localhost:3001` to see all your email templates rendered with live reload. Test with different prop values before deploying.

---

## Step 8 — Test in production (Resend provides test mode)

8.1. In Resend Dashboard → Logs, verify emails are being delivered (not bounced).

8.2. Check spam scores — if you skip domain verification, emails go to spam. Set up the DNS records.

8.3. Test the full welcome flow: sign up → check your inbox within 30 seconds.

---

## Definition of done

- [ ] New signups receive a welcome email within 60 seconds
- [ ] Stripe subscription confirmation email sends on `checkout.session.completed`
- [ ] Limit warning email sends when user hits 80% of their monthly searches
- [ ] Email templates render correctly in React Email preview
- [ ] Emails are not going to spam (domain verified in Resend)
- [ ] `npm run lint` passes
