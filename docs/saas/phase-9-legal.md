# Phase 9 — Legal Basics

**Goal:** Have the minimum required legal coverage in place before charging real money. This is not optional — it protects you from liability and is required by Stripe for live payments.

**Time estimate:** 4 hours (mostly filling out generators and writing the data disclaimer)

**Prerequisite:** Phase 6 (landing page/domain) — legal pages need a home

---

## What you actually need

You need three documents:
1. **Terms of Service** — the contract between you and users
2. **Privacy Policy** — required by law (CCPA for California users, GDPR if any EU users)
3. **Data Disclaimer** — specific to Henry: "we show public records, we're not a title company, verify everything"

You do NOT need (yet):
- Cookie policy (PostHog can run without cookies in anonymized mode)
- DMCA agent registration (you're not hosting user-uploaded content)
- SOC 2 certification (relevant at enterprise scale, not yet)
- EULA (for software downloads — not applicable here)

---

## Step 1 — Generate Terms of Service

Use Termly (termly.io) or GetTerms (getterms.io). Both have free tiers for basic TOS generation.

Key items to configure in the generator:

**Business details:**
- Company name: your legal name or LLC name
- Website URL: your Henry domain
- Contact email: your business email
- Governing law: North Carolina (where you operate)

**Service description:** "A web application that aggregates publicly available property records from Buncombe County, NC government sources and presents them in a unified report format."

**Critical clauses to verify are included:**
- Limitation of liability: cap liability at amounts paid in the last 12 months
- Disclaimer of warranties: "information is provided 'as is', for informational purposes only"
- No professional advice: data is not legal, financial, or professional real estate advice
- Acceptable use: no scraping, no automated bulk queries, no reselling data
- Termination: you can terminate accounts for abuse or non-payment
- Governing law and dispute resolution: NC courts, arbitration preferred

**Payment terms section** (add manually):
```
Subscription fees are billed monthly in advance. All fees are non-refundable except 
where required by law. We reserve the right to modify pricing with 30 days notice. 
Failure to pay will result in suspension of access. You may cancel any time; access 
continues through the end of the paid period.
```

---

## Step 2 — Generate Privacy Policy

Use the same tool (Termly) — it generates a matching Privacy Policy.

Key items to configure:

**Data you collect:**
- Email address (from Clerk signup)
- Name (optional, from Clerk)
- Search history (addresses and PINs searched)
- Payment information (collected by Stripe — note that you don't store card numbers)
- IP address (hashed — note this in the policy as "anonymized IP for rate limiting")
- Browser metadata: User-Agent, country, city, referrer (from Phase 3)
- Usage data: which features used, search frequency

**Third-party services to list:**
- Clerk (authentication) — clerk.com/privacy
- Stripe (payment processing) — stripe.com/privacy
- Neon (database hosting) — neon.tech/privacy
- Vercel (hosting) — vercel.com/legal/privacy-policy
- Resend (email) — resend.com/privacy
- PostHog (analytics) — posthog.com/privacy

**User rights (required for CCPA/GDPR):**
- Right to access their data
- Right to delete their account and data
- How to exercise these rights: email to your contact address

**Data retention:**
- Search history: retained for 1 year after account deletion, then purged
- Payment records: retained as required by Stripe and tax law (7 years)

---

## Step 3 — Write the Henry Data Disclaimer

This is the most important legal document specific to Henry's product. Generate a draft and then edit it carefully. This should be prominent in the UI, not buried in the footer.

**Suggested text:**

```
Data Sources and Accuracy Disclaimer

Henry aggregates information from publicly available government data sources, including 
Buncombe County GIS, the NC Register of Deeds, FEMA's National Flood Hazard Layer, 
USGS 3DEP elevation data, USDA SSURGO soil data, and other public databases.

Henry is a research tool, not a title search, survey, or professional appraisal. 
All information is provided for informational purposes only.

We do not guarantee the accuracy, completeness, or timeliness of any data. 
Government data sources may contain errors, may not reflect recent transactions 
or changes, and may be updated on schedules outside our control.

Do not rely solely on Henry's output for any real estate transaction, lending decision, 
insurance determination, or legal proceeding. Always verify critical information 
independently with the relevant county office, a licensed surveyor, title company, 
or attorney.

By using Henry, you agree that Henry, its operators, and its data providers 
are not liable for any decisions made based on information provided through this service.
```

---

## Step 4 — Add legal pages to the app

4.1. Create `web/app/terms/page.tsx` — server component, paste in your generated TOS as a `dangerouslySetInnerHTML` string or as structured JSX. Keep it readable.

4.2. Create `web/app/privacy/page.tsx` — same approach for Privacy Policy.

4.3. Add both pages to the site footer (Phase 6 already has a footer placeholder).

4.4. Add the data disclaimer to the property report page — a small, readable notice below the ContextGrid:

```tsx
// At the bottom of web/app/property/[runId]/page.tsx:
<div style={{ maxWidth: '720px', margin: '0 auto', padding: '0 16px 48px' }}>
  <p style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-faint)', lineHeight: '18px' }}>
    Data sourced from Buncombe County GIS, FEMA, USGS, USDA, and other public databases. 
    For informational purposes only — not legal, financial, or professional advice. 
    Verify all information independently before making decisions.{' '}
    <a href="/terms" style={{ color: 'inherit' }}>Terms</a>
    {' · '}
    <a href="/privacy" style={{ color: 'inherit' }}>Privacy</a>
  </p>
</div>
```

---

## Step 5 — Stripe requires legal pages before live mode

Before switching Stripe from test mode to live mode:

5.1. Go to Stripe Dashboard → Settings → Business Settings → Public Details. Fill in:
- Business name and address
- Support email
- Privacy policy URL
- Terms of service URL
- Refund policy (or note "all sales final except where required by law")

5.2. Stripe may require identity verification (KYC) — have your SSN or EIN and bank account details ready.

5.3. Set up your bank account for payouts: Stripe Dashboard → Balance → Add bank account.

5.4. Switch to live mode: Stripe Dashboard → Toggle "Test mode" off. Replace test API keys in Vercel env vars with live keys.

---

## Step 6 — Set up a business entity (optional but recommended)

Operating as a sole proprietor is fine to start, but an LLC:
- Separates personal liability from business liability
- Makes you look more credible to potential customers
- Required to open a business bank account at most banks

**North Carolina LLC formation:**
- File Articles of Organization at sosnc.gov — $125 filing fee
- Takes 5–7 business days
- You don't need a lawyer for a simple single-member LLC
- After formation, get an EIN from irs.gov (free, instant)
- Open a business checking account (Mercury, Relay, or your existing bank's business account)

This is a one-afternoon task. Do it before you have real revenue.

---

## Step 7 — Add a contact/support page

Users will have questions and issues. Give them a way to reach you.

Create `web/app/contact/page.tsx`:

```tsx
export default function ContactPage() {
  return (
    <div style={{ maxWidth: '480px', margin: '60px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: '20px', fontWeight: 500, marginBottom: '16px' }}>Contact</h1>
      <p style={{ color: 'var(--color-muted)', marginBottom: '24px' }}>
        Questions, feedback, or data accuracy issues? Email us at{' '}
        <a href="mailto:support@yourdomain.com">support@yourdomain.com</a>.
        We respond within 1 business day.
      </p>
      <p style={{ fontSize: '13px', color: 'var(--color-faint)' }}>
        To request deletion of your account and data, email us with the subject line 
        "Account deletion request" from the email address on your account.
      </p>
    </div>
  );
}
```

---

## Definition of done

- [ ] Terms of Service published at `/terms` with correct business name and NC governing law
- [ ] Privacy Policy published at `/privacy` listing all third-party services
- [ ] Data disclaimer visible on every property report page
- [ ] Stripe Business Settings has TOS and Privacy Policy URLs
- [ ] Stripe live mode enabled with bank account connected
- [ ] Contact email is monitored (set up email forwarding or alias if needed)
- [ ] LLC formation started or sole proprietor status confirmed (your choice)
