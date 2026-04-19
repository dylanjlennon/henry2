/**
 * POST /api/email/inbound
 *
 * Postmark inbound webhook. Receives parsed email, resolves the address
 * from the subject/body, runs all fetchers, and replies with findings +
 * PDF download links.
 *
 * Flow:
 *   1. Verify webhook token (POSTMARK_INBOUND_TOKEN in query string)
 *   2. Extract sender email + address from subject/body
 *   3. Rate limit: 3 email searches per sender per month
 *   4. Resolve address → CanonicalProperty
 *   5. Send immediate ACK email to sender
 *   6. Run all fetchers via waitUntil (same as web search)
 *   7. Send results email with findings + PDF links
 *
 * To set up:
 *   - Create a Postmark account → Inbound → set webhook URL to:
 *     https://henry-slack.vercel.app/api/email/inbound?token=<POSTMARK_INBOUND_TOKEN>
 *   - Point MX records for your domain to inbound.postmarkapp.com
 *   - Or use Postmark's provided address: anything@inbound.postmarkapp.com
 */

import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { resolveProperty, ResolveError } from '../../src/resolver/index.js';
import { ALL_FETCHERS } from '../../src/orchestrator/fetchers.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { ProvenanceRecorder } from '../../src/provenance/recorder.js';
import { canonicalToSnapshot } from '../../src/provenance/snapshot.js';
import { log } from '../../src/lib/log.js';
import { sendPropertyReportAck, sendPropertyReportResults } from '../../src/lib/email.js';
import type { Invocation, Artifact } from '../../src/provenance/schema.js';
import type { FetcherResult } from '../../src/types.js';
import type { ReportArtifact, ReportFindings } from '../../src/emails/PropertyReportResults.js';

const OUT_ROOT = process.env.OUT_ROOT ?? join(tmpdir(), 'henry-runs');

// 3 free email searches per sender per month
const EMAIL_RATE_LIMIT = 3;
const EMAIL_RATE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Postmark inbound email payload (subset of fields we use) */
interface PostmarkInbound {
  From: string;          // "Jane Agent <jane@kw.com>" or "jane@kw.com"
  FromFull?: { Email: string; Name: string };
  Subject: string;
  TextBody: string;
  HtmlBody?: string;
  MessageID: string;
  ReplyTo?: string;
}

function getBaseUrl(): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://henry-slack.vercel.app';
}

/** Extract plain email address from "Name <email>" or bare "email" */
function extractEmail(raw: string): string {
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

/**
 * Pull an address out of the email. Try subject first (most common),
 * fall back to first substantive line of the text body.
 * Strip common verbs/prefixes agents might use.
 */
function extractAddress(subject: string, textBody: string): string {
  const clean = (s: string) =>
    s
      .replace(/^(re|fwd|fw)\s*:\s*/i, '')
      .replace(/^(research|pull|check|look\s*up|lookup|run|get|search|analyze|analyse|report\s*on|can you|please|hey|hi)\s*/i, '')
      .replace(/\?+$/, '')
      .trim();

  const fromSubject = clean(subject);
  if (fromSubject.length > 5) return fromSubject;

  // Try first non-empty line of the text body
  const lines = textBody.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines.slice(0, 3)) {
    const fromLine = clean(line);
    if (fromLine.length > 5) return fromLine;
  }

  return fromSubject;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  // Verify webhook token — Postmark sends to /api/email/inbound?token=xxx
  const token = req.query['token'] as string | undefined;
  if (!process.env.POSTMARK_INBOUND_TOKEN || token !== process.env.POSTMARK_INBOUND_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const body = req.body as PostmarkInbound;
  const senderEmail = body.FromFull?.Email
    ? body.FromFull.Email.toLowerCase()
    : extractEmail(body.From);

  if (!senderEmail || !senderEmail.includes('@')) {
    res.status(200).json({ ok: true, skipped: 'no_sender' });
    return;
  }

  const senderHash = createHash('sha256').update(senderEmail).digest('hex');
  const rawAddress = extractAddress(body.Subject ?? '', body.TextBody ?? '');

  const hlog = log.child({ source: 'email', sender: senderEmail.slice(0, 4) + '***' });

  if (!rawAddress || rawAddress.length < 5) {
    hlog.warn('email_no_address_found', { subject: body.Subject });
    // Reply with a help message
    await sendHelpEmail(senderEmail, body.Subject);
    res.status(200).json({ ok: true, skipped: 'no_address' });
    return;
  }

  // ACK Postmark immediately — they retry if we don't respond fast
  res.status(200).json({ ok: true });

  // Everything else runs in the background
  waitUntil(processEmailSearch({
    senderEmail,
    senderHash,
    rawAddress,
    messageId: body.MessageID,
    hlog,
  }));
}

async function processEmailSearch(opts: {
  senderEmail: string;
  senderHash: string;
  rawAddress: string;
  messageId: string;
  hlog: ReturnType<typeof log.child>;
}): Promise<void> {
  const { senderEmail, senderHash, rawAddress, hlog } = opts;
  const stack = await makeProvenanceStack();
  const baseUrl = getBaseUrl();

  // Rate limit check
  const recent = await stack.store.countRecentEmailRunsBySender(senderHash, EMAIL_RATE_WINDOW_MS);
  if (recent >= EMAIL_RATE_LIMIT) {
    hlog.info('email_rate_limited', { count: recent });
    await sendRateLimitEmail(senderEmail, baseUrl);
    return;
  }

  // Resolve address
  let property;
  try {
    property = await resolveProperty({ raw: rawAddress, county: 'buncombe' });
  } catch (err) {
    const msg = err instanceof ResolveError ? err.message : 'Could not find that address in Buncombe County, NC.';
    hlog.warn('email_resolve_failed', { rawAddress, err: String(err) });
    await sendResolveErrorEmail(senderEmail, rawAddress, msg, baseUrl);
    return;
  }

  // Create provenance records
  const invocation: Invocation = {
    id: randomUUID(),
    trigger: 'email',
    slackTeamId: null,
    slackUserId: null,
    slackChannelId: null,
    slackChannelName: null,
    slackThreadTs: null,
    rawInput: rawAddress,
    createdAt: new Date().toISOString(),
    ipHash: senderHash,   // reuse ip_hash column for sender hash (same rate-limit purpose)
    metadata: { userAgent: 'email', referer: senderEmail.split('@')[1] ?? null },
  };

  const recorder = new ProvenanceRecorder({
    store: stack.store,
    artifactStore: stack.artifactStore,
    invocation,
  });
  await recorder.saveInvocation();
  await recorder.startRun(canonicalToSnapshot(property));

  hlog.info('email_run_started', { runId: recorder.runId, pin: property.pin });

  // Send ACK immediately
  await sendPropertyReportAck({
    to: senderEmail,
    address: property.address ?? rawAddress,
    pin: property.pin,
  });

  // Run fetchers
  let runStatus: 'completed' | 'partial' | 'failed' = 'completed';

  try {
    const active = ALL_FETCHERS.filter((f) => f.counties.includes(property.county));
    await recorder.setFetchersPlanned(active.length);

    let results: FetcherResult[];
    const internalToken = process.env.HENRY_INTERNAL_TOKEN;

    results = await Promise.all(
      active.map(async (f): Promise<FetcherResult> => {
        try {
          const resp = await fetch(`${baseUrl}/api/fetchers/${f.id}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(internalToken ? { 'x-henry-internal': internalToken } : {}),
            },
            body: JSON.stringify({
              runId: recorder.runId,
              invocationId: recorder.invocation.id,
              property,
            }),
            signal: AbortSignal.timeout(280_000),
          });
          if (!resp.ok) throw new Error(`fetcher HTTP ${resp.status}`);
          const data = (await resp.json()) as { result: FetcherResult; artifacts?: Artifact[] };
          return data.result;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          hlog.warn('email_fetcher_failed', { fetcherId: f.id, err: msg });
          return { fetcher: f.id, status: 'failed', files: [], error: msg, durationMs: 0 };
        }
      }),
    );

    recorder.setFetcherResultTotals(results);
    const failed = results.filter((r) => r.status === 'failed').length;
    const completed = results.filter((r) => r.status === 'completed').length;
    if (failed > 0) runStatus = completed > 0 ? 'partial' : 'failed';
  } catch (err) {
    runStatus = 'failed';
    hlog.error('email_run_error', { err: String(err) });
  }

  try {
    await recorder.finishRun({ status: runStatus });
  } catch (e) {
    await new Promise((r) => setTimeout(r, 2_000));
    await recorder.finishRun({ status: runStatus }).catch(() => {});
  }

  if (runStatus === 'failed') {
    await sendRunFailedEmail(senderEmail, property.address ?? rawAddress, baseUrl);
    return;
  }

  // Query completed run data for the results email
  // Access the postgres pool directly — email handler only runs in prod where backend=postgres
  const { getSharedPool } = await import('../../src/provenance/postgresStore.js');
  const pool = await getSharedPool();

  const [fcRows, artRows, runRow] = await Promise.all([
    pool.query<{ fetcher_id: string; data: Record<string, unknown> | null }>(
      `SELECT fetcher_id, data FROM fetcher_calls WHERE run_id = $1 AND status = 'completed'`,
      [recorder.runId],
    ),
    pool.query<{ label: string; content_type: string; bytes: number; storage_uri: string }>(
      `SELECT label, content_type, bytes, storage_uri FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC`,
      [recorder.runId],
    ),
    pool.query<{ duration_ms: number | null; fetchers_completed: number; fetchers_total: number }>(
      `SELECT duration_ms, fetchers_completed, fetchers_total FROM runs WHERE id = $1`,
      [recorder.runId],
    ),
  ]);

  // Build findings from fetcher data
  const fetcherData: Record<string, Record<string, unknown>> = {};
  for (const row of fcRows.rows) {
    if (row.data) fetcherData[row.fetcher_id] = row.data;
  }

  const fema = fetcherData['fema-flood'] as { floodZone?: string; zoneSubtype?: string } | undefined;
  const septic = fetcherData['septic'] as { onSeptic?: boolean } | undefined;
  const str = fetcherData['str-eligibility'] as { eligible?: boolean | null; rulesJurisdiction?: string } | undefined;
  const parcel = fetcherData['parcel-json'] as { attributes?: { TaxValue?: string; Acreage?: number; DeedBook?: string; DeedPage?: string } } | undefined;
  const attrs = parcel?.attributes;

  const findings: ReportFindings = {
    floodZone: fema?.floodZone,
    floodZoneSubtype: fema?.zoneSubtype,
    strEligible: str?.eligible,
    strJurisdiction: str?.rulesJurisdiction,
    onSeptic: septic?.onSeptic,
    taxValue: attrs?.TaxValue,
    acreage: attrs?.Acreage,
    deedBook: attrs?.DeedBook,
    deedPage: attrs?.DeedPage,
  };

  const artifacts: ReportArtifact[] = artRows.rows.map((r: { label: string; content_type: string; bytes: number; storage_uri: string }) => ({
    label: r.label,
    contentType: r.content_type,
    bytes: r.bytes,
    storageUri: r.storage_uri,
  }));

  const run = runRow.rows[0];
  const webUrl = `${baseUrl}/property/${recorder.runId}`;

  await sendPropertyReportResults({
    to: senderEmail,
    address: property.address ?? rawAddress,
    pin: property.pin,
    ownerName: property.ownerName ?? null,
    durationMs: run?.duration_ms ?? null,
    fetchersCompleted: run?.fetchers_completed ?? 0,
    fetchersTotal: run?.fetchers_total ?? 0,
    artifacts,
    findings,
    webUrl,
  });

  hlog.info('email_results_sent', { runId: recorder.runId, artifacts: artifacts.length });
}

// ── Helper email senders ────────────────────────────────────────────────────

async function sendHelpEmail(to: string, originalSubject: string): Promise<void> {
  const { Resend } = await import('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const FROM = process.env.EMAIL_FROM ?? 'Henry <research@henryproperty.co>';
  await resend.emails.send({
    from: FROM,
    to,
    subject: `Re: ${originalSubject || 'Your Henry request'}`,
    text: [
      "Hi — Henry here.",
      "",
      "I couldn't find a Buncombe County address in your email. To get a property report, just email me with the address in the subject line. For example:",
      "",
      "  Subject: 546 Old Haw Creek Rd, Asheville NC",
      "",
      "I cover all of Buncombe County, NC. Street addresses or 15-digit PINs both work.",
      "",
      "— Henry",
    ].join('\n'),
  });
}

async function sendRateLimitEmail(to: string, baseUrl: string): Promise<void> {
  const { Resend } = await import('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const FROM = process.env.EMAIL_FROM ?? 'Henry <research@henryproperty.co>';
  await resend.emails.send({
    from: FROM,
    to,
    subject: "You've used your 3 free Henry searches",
    text: [
      "You've used all 3 of your free monthly email searches.",
      "",
      `Sign up for a Henry account to get unlimited searches: ${baseUrl}/sign-up`,
      "",
      "— Henry",
    ].join('\n'),
  });
}

async function sendResolveErrorEmail(to: string, rawAddress: string, msg: string, baseUrl: string): Promise<void> {
  const { Resend } = await import('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const FROM = process.env.EMAIL_FROM ?? 'Henry <research@henryproperty.co>';
  await resend.emails.send({
    from: FROM,
    to,
    subject: `Henry couldn't find: ${rawAddress}`,
    text: [
      `I couldn't locate "${rawAddress}" in Buncombe County, NC.`,
      "",
      msg,
      "",
      "Tips:",
      "  - Include the full street address: 546 Old Haw Creek Rd, Asheville NC",
      "  - Or use a 15-digit PIN from the county GIS",
      "  - Henry covers Buncombe County only",
      "",
      `You can also search directly at: ${baseUrl}`,
      "",
      "— Henry",
    ].join('\n'),
  });
}

async function sendRunFailedEmail(to: string, address: string, baseUrl: string): Promise<void> {
  const { Resend } = await import('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const FROM = process.env.EMAIL_FROM ?? 'Henry <research@henryproperty.co>';
  await resend.emails.send({
    from: FROM,
    to,
    subject: `Henry report failed: ${address}`,
    text: [
      `Something went wrong pulling records for ${address}.`,
      "",
      "This is usually a temporary issue with one of the county data sources. Please try again in a few minutes.",
      "",
      `Try it directly at: ${baseUrl}`,
      "",
      "— Henry",
    ].join('\n'),
  });
}
