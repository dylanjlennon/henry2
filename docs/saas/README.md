# Henry SaaS — Master Roadmap

Property research SaaS for Buncombe County, NC. Converts a public-data research tool into a paid product for real estate agents, investors, and STR operators.

---

## Product summary

**What it does:** Enter any Buncombe County address or PIN → receive a complete property intelligence dossier in ~2 minutes: 12 public data sources, all documents as PDFs, key risk signals surfaced automatically.

**Who pays for it:** Real estate agents (need this for every listing and buyer consult), short-term rental investors (STR eligibility is a $0 vs $100k/yr question), residential investors, property managers, contractors doing due diligence.

**Why they pay:** The alternative is 2–4 hours of manual research across 6 county websites. Henry does it in 2 minutes. At $29–99/month, it pays for itself on the first search of the month.

---

## Pricing model

| Plan | Price | Searches/month | Target |
|---|---|---|---|
| Free | $0 | 5 | Try-before-you-buy |
| Starter | $29/mo | 50 | Solo agent / investor |
| Pro | $99/mo | 250 | Active agent / small team |
| Team | $249/mo | 1,000 | Brokerage / property manager |

All plans: full 12-source report, all PDFs, 24-hour result cache (repeat searches on same property don't cost a credit).

---

## Tech stack decisions

| Concern | Choice | Why |
|---|---|---|
| Auth | Clerk v6 | Native Vercel Marketplace, Next.js App Router SDK, handles email/Google/magic links |
| Payments | Stripe Billing + Checkout | Industry standard, best webhook reliability, metered billing support |
| Transactional email | Resend + React Email | Modern, Next.js native, deliverability is excellent |
| Analytics | PostHog | Open-source, self-hostable, event funnels, session replay, feature flags |
| Error monitoring | Sentry | Standard, Vercel integration, catches serverless cold-start errors |
| DB | Neon Postgres (Scale plan) | Already in use — upgrade for connection pooling at load |
| Queue | Vercel Queues | Replaces `waitUntil` fan-out at scale, durable delivery |
| Cache | DB-level PIN cache + Vercel Runtime Cache | Prevents hammering county APIs |
| Landing page | Next.js + Tailwind (same repo) | No new infra needed |

---

## Phases

| Phase | Document | Time estimate | Unblocks |
|---|---|---|---|
| 1 | [Auth — Clerk](./phase-1-auth.md) | 2 days | Everything |
| 2 | [Result caching](./phase-2-caching.md) | 1 day | Scale, cost |
| 3 | [Billing — Stripe](./phase-3-billing.md) | 2 days | Revenue |
| 4 | [Usage enforcement](./phase-4-usage.md) | 1 day | Business model |
| 5 | [Transactional email — Resend](./phase-5-email.md) | 1 day | Retention |
| 6 | [Landing + pricing page](./phase-6-landing.md) | 2 days | Acquisition |
| 7 | [Analytics — PostHog](./phase-7-analytics.md) | 1 day | Understanding |
| 8 | [Scale hardening](./phase-8-scale.md) | 2 days | 400 concurrent users |

**Total estimate: ~12 working days.** Do them in order — each phase depends on the one before it.

---

## Database schema additions overview

All schema changes are additive. Existing tables (`invocations`, `runs`, `fetcher_calls`, `http_hits`, `artifacts`) are untouched except for one new column on `invocations`.

New tables added across phases:
- `users` — auth identity + subscription state (Phase 1)
- `pin_cache` — 24-hour result cache keyed by PIN (Phase 2)
- `usage_events` — per-search accounting (Phase 4)

---

## Success metrics to track from day one

- **Activation rate:** % of signups who run at least 1 search
- **Search-to-paid conversion:** % of free users who hit their limit and upgrade
- **Searches per active user per month:** tells you if the product is sticky
- **Cache hit rate:** target >40% within 60 days (means people are searching the same properties)
- **Fetcher failure rate:** stay below 5% overall; any fetcher >15% failure rate needs investigation
