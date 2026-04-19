# Phase 6 — Landing Page + Pricing Page

**Goal:** Replace the current search-as-homepage with a proper marketing landing page that converts visitors into signups. The actual search tool lives at `/search` (behind auth). The landing page must explain what Henry does, who it's for, and what it costs — without requiring a signup to understand the value.

**Time estimate:** 2 days

**Prerequisite:** Phase 1 (auth working, `/search` route exists)

---

## Step 1 — Page structure and routing

After Phase 1, the route structure is:

```
/                   → Marketing landing page (public)
/pricing            → Pricing table (public)
/sign-in            → Clerk sign-in (public)
/sign-up            → Clerk sign-up (public)
/search             → Search tool (requires auth)
/property/[runId]   → Property report (requires auth)
/account            → Account/billing (requires auth)
/billing/success    → Post-Stripe-checkout success page (requires auth)
```

---

## Step 2 — Landing page structure

The landing page (`web/app/page.tsx`) should have these sections in order:

1. **Nav bar** — Logo, "Pricing" link, "Sign in" link, "Get started" CTA button
2. **Hero** — Headline, subheadline, single search bar with a fake/demo animation, social proof line
3. **Demo / "What you get"** — Screenshot or animated walkthrough of a real property report
4. **Data sources** — The 12 sources listed visually (this builds trust)
5. **Who it's for** — Three columns: Real estate agents, STR investors, Property managers
6. **Pricing table** — Identical to `/pricing` page, inline here for conversion
7. **FAQ** — 5–7 common questions
8. **Footer** — Links, legal, data disclaimer

---

## Step 3 — Nav bar component

Create `web/components/landing/LandingNav.tsx`:

```tsx
'use client';
import Link from 'next/link';
import { SignedIn, SignedOut } from '@clerk/nextjs';

export default function LandingNav() {
  return (
    <nav style={{
      position: 'sticky', top: 0, zIndex: 100,
      background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(8px)',
      borderBottom: '1px solid var(--color-rule)',
      height: '56px', display: 'flex', alignItems: 'center',
      padding: '0 32px', justifyContent: 'space-between',
    }}>
      <Link href="/" style={{ fontWeight: 700, fontSize: '18px', textDecoration: 'none', color: 'var(--color-ink)' }}>
        Henry<span style={{ color: 'var(--color-info)' }}>.</span>
      </Link>
      <div style={{ display: 'flex', alignItems: 'center', gap: '24px', fontSize: '14px' }}>
        <Link href="/pricing" style={{ color: 'var(--color-muted)', textDecoration: 'none' }}>Pricing</Link>
        <SignedIn>
          <Link href="/search" style={{
            background: 'var(--color-info)', color: '#fff', textDecoration: 'none',
            padding: '7px 18px', borderRadius: 'var(--radius-default)', fontWeight: 500,
          }}>
            Open Henry →
          </Link>
        </SignedIn>
        <SignedOut>
          <Link href="/sign-in" style={{ color: 'var(--color-muted)', textDecoration: 'none' }}>Sign in</Link>
          <Link href="/sign-up" style={{
            background: 'var(--color-info)', color: '#fff', textDecoration: 'none',
            padding: '7px 18px', borderRadius: 'var(--radius-default)', fontWeight: 500,
          }}>
            Get started free →
          </Link>
        </SignedOut>
      </div>
    </nav>
  );
}
```

---

## Step 4 — Hero section

The headline must immediately communicate the core value. Suggested copy:

**Headline:** "Every public record on any Buncombe County property. In 2 minutes."

**Subheadline:** "Henry searches 12 county data sources simultaneously and delivers the complete picture: deed, tax bill, flood map, permits, STR eligibility, landslide risk, and more — as downloadable PDFs."

**Social proof line:** (once you have users) "Used by X Asheville-area agents and investors."

Include a single read-only input showing `546 Old Haw Creek Rd, Asheville, NC` with a "Try it free →" button that goes to `/sign-up`.

---

## Step 5 — "What you get" section

Show a real screenshot of the property report for a known address. Use an actual screenshot of the running product — not a mockup. Update this whenever the UI changes.

Alternatively, build a minimal animated demo: show the 12 fetcher pills going from pending → completed one by one, then the document cards appearing. This can be CSS animation only — no live API calls.

For the screenshot approach:
1. Run Henry on a good address (try `100 Beaverdam Rd, Asheville` — has interesting terrain and permits data)
2. Take a full-page screenshot at 1280px width
3. Crop to show the PropertyHero, KeyFindings, DocumentsPanel, and first 4 ContextGrid tiles
4. Save to `web/public/screenshot-property-report.png`
5. Display with a subtle drop shadow and border at `max-width: 800px`

---

## Step 6 — Data sources section

Create a visual grid of the 12 data sources. Each source shows:
- Icon (use a simple Unicode symbol or SVG)
- Source name
- What data comes from it

```
🏛️ Buncombe County GIS     → Parcel boundary, ownership, acreage, deed reference
💰 Buncombe County Tax      → Assessed value, tax bill PDF
📄 Register of Deeds        → Deed document PDF
🗺️ GIS Parcel Map          → Official parcel map PDF
📐 Plat Maps               → Subdivision plat PDF
🌊 FEMA NFHL               → Flood zone, FIRM panel map
🏠 NC Building Permits      → Permits history
🌿 NCGS Landslide Database  → Landslide hazard, debris flows
⛰️ USGS 3DEP               → Elevation, slope percentage
🌱 USDA SSURGO             → Soil type, septic suitability
🏘️ Buncombe GIS (Adjacent)  → Neighboring owners and zoning
📊 FEMA National Risk Index → Composite hazard score
```

Display as a 3×4 grid (desktop) or 2×6 (mobile). Keep it scannable — these sources are what justify the price.

---

## Step 7 — "Who it's for" section

Three cards, each aimed at a buyer persona:

**Real Estate Agents**
"Pull a complete due diligence report before your listing appointment. Impress clients with flood zone data, permit history, and deed references in hand — all in 2 minutes, before the competition."

**STR Investors**
"STR eligibility in Asheville and Buncombe County is zoning-dependent and frequently misunderstood. Henry tells you definitively whether a property can be permitted as a short-term rental — and flags historic district overlays that add approval requirements."

**Property Managers & Investors**
"Running comps or evaluating an acquisition? Skip the county website maze. Henry gives you the full public record — soil, slope, flood, permits, neighboring owners — in one report."

---

## Step 8 — FAQ section

```
Q: Is the data accurate?
A: Henry fetches data directly from authoritative public sources: Buncombe County GIS, FEMA, USGS, and the NC Geological Survey. Data is as current as those sources — typically updated daily to weekly. Henry is a research tool, not a legal opinion.

Q: What counties does Henry cover?
A: Currently Buncombe County, NC only — including the City of Asheville, Weaverville, Black Mountain, and all unincorporated areas. Expansion to neighboring counties is planned.

Q: How long does a search take?
A: Typically 90–150 seconds. If the same property was searched in the past 24 hours, results are instant (cached).

Q: Does a repeat search on the same property use a credit?
A: No. If the same property was looked up today, you get the cached result instantly with no credit consumed.

Q: Can I try it before paying?
A: Yes. Every account starts with 5 free searches, no credit card required.

Q: What's in the free plan?
A: The same full 12-source report as paid plans. The only difference is the number of searches per month (5 free, 50–1,000 on paid plans).

Q: Can I cancel anytime?
A: Yes. Cancel from your account page. You keep access through the end of your billing period.
```

---

## Step 9 — Footer

Minimal footer with:
- Copyright: `© 2026 Henry · Buncombe County Property Research`
- Links: Pricing · Privacy Policy · Terms of Service · Contact
- Data disclaimer: "Henry aggregates publicly available county data. Results are for informational purposes only and do not constitute legal, financial, or professional advice. Verify all information independently before making decisions."

---

## Step 10 — Performance and SEO basics

10.1. Add `metadata` export to `web/app/page.tsx`:
```typescript
export const metadata = {
  title: 'Henry — Buncombe County Property Research',
  description: 'Pull deed, tax, flood, permits, STR eligibility, and 12 other data sources for any Buncombe County property. Research in 2 minutes, not 4 hours.',
  openGraph: {
    title: 'Henry — Buncombe County Property Research',
    description: 'Complete property intelligence for Buncombe County, NC.',
    url: 'https://henry-web-inky.vercel.app',
    type: 'website',
    images: [{ url: '/screenshot-property-report.png', width: 1200, height: 630 }],
  },
};
```

10.2. The landing page should be a **server component** (no `'use client'`) except for the nav (which uses Clerk's `SignedIn`/`SignedOut` — those require client context). Use a `LandingNav` client component, keep the page body as server-rendered HTML. This makes Google indexing trivial — no JS required to see content.

10.3. Add `sitemap.ts` to the `web/app/` directory:
```typescript
import type { MetadataRoute } from 'next';
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: 'https://henry-web-inky.vercel.app', lastModified: new Date(), priority: 1 },
    { url: 'https://henry-web-inky.vercel.app/pricing', lastModified: new Date(), priority: 0.8 },
  ];
}
```

10.4. Submit to Google Search Console once the domain is on a real domain (not `.vercel.app`).

---

## Step 11 — Custom domain

This is part of Phase 6 because you need a real domain before seriously marketing anything.

11.1. Register a domain: `gethenry.co`, `henryproperty.com`, `househenry.com`, `askhenry.co` — search Namecheap or Cloudflare Registrar. Aim for `.com` or `.co`.

11.2. In Vercel → Project → Domains → Add domain. Follow DNS setup instructions (usually adding CNAME or A records at your registrar).

11.3. Update `PUBLIC_BASE_URL` env var to the new domain.

11.4. Update all hardcoded `henry-slack.vercel.app` and `henry-web-inky.vercel.app` references in the codebase. Search with: `grep -r "vercel.app" --include="*.ts" --include="*.tsx" .`

---

## Definition of done

- [ ] Landing page at `/` explains value, data sources, who it's for, and pricing
- [ ] "Get started" CTAs link to `/sign-up`
- [ ] Signed-in users see "Open Henry →" in nav instead of sign-up
- [ ] `/pricing` page is a standalone route
- [ ] Page renders without JavaScript (server component)
- [ ] OG image works (paste URL into https://www.opengraph.xyz to verify)
- [ ] Custom domain is pointing to Vercel
- [ ] `npm run lint` passes
