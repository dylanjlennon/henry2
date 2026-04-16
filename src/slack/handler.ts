/**
 * Shared Slack handler logic.
 *
 * Both the slash-command (`/henry …`) and the app-mention (`@henry …`)
 * entry points funnel into `handleHenryInvocation`, which:
 *   1. Resolves what property to research.
 *   2. Opens an Invocation + Run in the provenance store.
 *   3. Posts an initial "on it" message with a thread anchor.
 *   4. Kicks off the orchestrator; streams per-fetcher progress to the thread.
 *   5. As each fetcher completes, immediately posts inline findings (data
 *      fetchers) or uploads the artifact (document fetchers).
 *   6. Posts a final summary line.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebClient } from '@slack/web-api';
import { resolveProperty, ResolveError } from '../resolver/index.js';
import { runFetchers } from '../orchestrator/index.js';
import { ALL_FETCHERS } from '../orchestrator/fetchers.js';
import { inferPropertyFromChannelName } from './channelName.js';
import { log } from '../lib/log.js';
import type { CanonicalProperty, ProgressEvent, FetcherResult, Fetcher } from '../types.js';
import { makeProvenanceStack, type ProvenanceStack } from '../provenance/factory.js';
import { ProvenanceRecorder } from '../provenance/recorder.js';
import { canonicalToSnapshot } from '../provenance/snapshot.js';
import type { Invocation, Artifact } from '../provenance/schema.js';
import type { ArtifactStore } from '../provenance/store.js';

export interface InvocationInput {
  text: string;
  trigger: 'slack-slash' | 'slack-mention';
  teamId?: string;
  channelId: string;
  channelName?: string;
  userId: string;
  threadTs?: string;
  slack: WebClient;
  /**
   * Pre-built provenance stack. Pass this when you've already opened a DB
   * connection before sending the HTTP ACK (required in Vercel serverless).
   */
  provenanceStack?: ProvenanceStack;
}

const OUT_ROOT = process.env.OUT_ROOT ?? join(tmpdir(), 'henry-runs');

// Base URL for internal fan-out calls to /api/fetchers/:id.
// PUBLIC_BASE_URL is preferred (stable); VERCEL_URL is the deployment-specific URL.
// When neither is set (local dev / CLI) the handler falls back to in-process.
function getFanOutBaseUrl(): string | null {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return null;
}
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? '';

export async function handleHenryInvocation(input: InvocationInput): Promise<void> {
  const { text, channelId, channelName, userId, slack } = input;

  // 1. Figure out the property input.
  const propertyInput = chooseInput(text, channelName);
  if (!propertyInput) {
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: input.threadTs,
      text: ":confused: I couldn't figure out what property to look up. Try `/henry 546 Old Haw Creek Rd` or `/henry 9648-65-1234-00000`.",
    });
    return;
  }

  // 2. Provenance: open an Invocation row.
  const { store, artifactStore, backendLabel } = input.provenanceStack ?? await makeProvenanceStack();
  const invocation: Invocation = {
    id: randomUUID(),
    trigger: input.trigger,
    slackTeamId: input.teamId ?? null,
    slackUserId: userId,
    slackChannelId: channelId,
    slackChannelName: channelName ?? null,
    slackThreadTs: input.threadTs ?? null,
    rawInput: propertyInput.raw,
    createdAt: new Date().toISOString(),
  };
  const recorder = new ProvenanceRecorder({ store, artifactStore, invocation });
  await recorder.saveInvocation();
  const hlog = log.child({ runId: recorder.runId, invocationId: invocation.id, backend: backendLabel });
  hlog.info('invocation_received', { raw: propertyInput.raw, source: propertyInput.source });

  // 3. Post initial "on it" message.
  const posted = await slack.chat.postMessage({
    channel: channelId,
    thread_ts: input.threadTs,
    text: `:mag: Henry is looking up *${propertyInput.raw}*${
      propertyInput.source === 'channel-name' ? ` _(from this channel's name)_` : ''
    }…`,
  });
  const threadTs = input.threadTs ?? (posted.ts as string);

  // 4. Resolve property → PIN + address + centroid + deed/plat refs.
  let property: CanonicalProperty;
  try {
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:globe_with_meridians: Resolving address against Buncombe County GIS…`,
    });
    property = await resolveProperty({ raw: propertyInput.raw, county: 'buncombe' });
  } catch (err) {
    const msg = err instanceof ResolveError ? err.message : (err as Error).message;
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:x: *Could not resolve property*\n${msg}\n\n_Try a full street address or a 15-digit PIN._`,
    });
    hlog.warn('resolve_failed', { err: msg });
    return;
  }

  await recorder.startRun(canonicalToSnapshot(property));

  // Post resolved property card.
  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: renderPropertyCard(property, recorder.runId),
    mrkdwn: true,
  });

  // 5. Run fetchers with live progress updates in a single editable message.
  const progressLines: Map<string, string> = new Map();
  let progressMsgTs: string | undefined;

  const flushProgress = async (): Promise<void> => {
    const text = Array.from(progressLines.values()).join('\n');
    if (progressMsgTs) {
      await slack.chat.update({ channel: channelId, ts: progressMsgTs, text }).catch(() => undefined);
    } else {
      const r = await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
      progressMsgTs = r.ts as string;
    }
  };

  // onProgress is only used in the local in-process fallback path below.
  const onProgress = (ev: ProgressEvent): void => {
    if (ev.fetcher === 'orchestrator') return;
    const emoji = progressEmoji(ev.status);
    const suffix = ev.message ? ` — ${ev.message}` : ev.error ? ` — \`${truncateError(ev.error, 100)}\`` : '';
    progressLines.set(ev.fetcher, `${emoji} *${ev.fetcher}*${suffix}`);
    flushProgress().catch((e) => hlog.warn('progress_flush_failed', { err: String(e) }));
  };

  let runStatus: 'completed' | 'partial' | 'failed' = 'completed';
  try {
    const baseUrl = getFanOutBaseUrl();
    const t0 = Date.now();
    let results: FetcherResult[];
    let durationMs: number;

    if (baseUrl) {
      // Fan-out: each fetcher runs as its own parallel Vercel Function.
      // Per-fetcher findings + artifact uploads happen inside runFetchersFanOut
      // as each settles, so there's nothing more to post after it returns.
      results = await runFetchersFanOut(
        ALL_FETCHERS, property, recorder, baseUrl,
        progressLines, flushProgress, hlog,
        { slack, channelId, threadTs, artifactStore },
      );
      durationMs = Date.now() - t0;
    } else {
      // Local dev fallback: run everything in-process with concurrency limit.
      const summary = await runFetchers(ALL_FETCHERS, property, {
        outRoot: OUT_ROOT,
        onProgress,
        recorder,
        browserConcurrency: 2,
        fetcherTimeoutMs: 180_000,
      });
      results = summary.results;
      durationMs = summary.durationMs;

      // In-process path: post all findings and upload all artifacts at the end
      // (fan-out does these inline as each fetcher settles).
      const findingsText = renderFindings(results);
      if (findingsText) {
        await slack.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: findingsText,
          mrkdwn: true,
        });
      }
      const trace = await store.getRunTrace(recorder.runId);
      const toUpload = (trace?.artifacts ?? []).filter((a) => a.contentType !== 'application/json');
      for (const artifact of toUpload) {
        await uploadSingleArtifact(slack, channelId, threadTs, artifact, artifactStore, hlog);
      }
    }

    const totals = {
      total: results.length,
      completed: results.filter((r) => r.status === 'completed').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
      filesProduced: results.reduce((n, r) => n + r.files.length, 0),
    };

    if (totals.failed > 0) runStatus = totals.completed > 0 ? 'partial' : 'failed';

    // 6. Final summary.
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: renderSummary(property, totals, durationMs, recorder.runId),
      mrkdwn: true,
    });
  } catch (err) {
    runStatus = 'failed';
    const msg = truncateError((err as Error).message ?? String(err), 500);
    hlog.error('run_error', { err: msg });
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:x: *Run crashed*\n\`\`\`${msg}\`\`\``,
    });
  } finally {
    await retryOnce(() => recorder.finishRun({ status: runStatus }), hlog, 'finish_run');
    hlog.info('run_closed', { status: runStatus });
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function renderPropertyCard(p: CanonicalProperty, runId: string): string {
  const lines = [`:pushpin: *${p.pin}*`];
  if (p.address) lines.push(`  • Address: ${p.address}`);
  if (p.ownerName) lines.push(`  • Owner: ${p.ownerName}`);
  if (p.deed) lines.push(`  • Deed: Book ${p.deed.book} / Page ${p.deed.page}`);
  if (p.plat) lines.push(`  • Plat: Book ${p.plat.book} / Page ${p.plat.page}`);
  lines.push(`  • Confidence: ${(p.confidence * 100).toFixed(0)}% (${p.source})`);
  if (PUBLIC_BASE_URL) {
    lines.push(`  • Trace: <${PUBLIC_BASE_URL}/api/runs/${runId}|${runId.slice(0, 8)}>`);
  }
  return lines.join('\n');
}

/**
 * Render the inline findings for a single fetcher result.
 * Returns null for artifact-only fetchers (PDFs etc.) whose content is
 * self-explanatory once uploaded, and for skipped fetchers.
 */
function renderFetcherResult(result: FetcherResult): string | null {
  if (result.status === 'skipped') return null;

  if (result.status === 'failed') {
    return `:x: *${result.fetcher}* failed\n\`\`\`${truncateError(result.error)}\`\`\``;
  }

  if (result.status !== 'completed' || !result.data) return null;

  const d = result.data as Record<string, unknown>;

  if (result.fetcher === 'parcel-json') {
    const a = (d.attributes ?? {}) as Record<string, unknown>;
    const lines = [`:file_folder: *Parcel record*`];
    if (a.OwnerName ?? a.OwnerName1) lines.push(`  • Owner: ${a.OwnerName ?? a.OwnerName1}`);
    if (a.PropAddr ?? a.PropertyAddress) lines.push(`  • Address: ${a.PropAddr ?? a.PropertyAddress}`);
    if (a.LandValue != null) lines.push(`  • Land value: $${Number(a.LandValue).toLocaleString()}`);
    if (a.TotalValue != null) lines.push(`  • Total assessed value: $${Number(a.TotalValue).toLocaleString()}`);
    if (a.Acreage ?? a.ACREAGE) lines.push(`  • Acreage: ${a.Acreage ?? a.ACREAGE}`);
    if (a.YearBuilt ?? a.YEARBUILT) lines.push(`  • Year built: ${a.YearBuilt ?? a.YEARBUILT}`);
    if (a.DeedBook && a.DeedPage) lines.push(`  • Deed: Book ${a.DeedBook} / Page ${a.DeedPage}`);
    if (a.PlatBook && a.PlatPage) lines.push(`  • Plat: Book ${a.PlatBook} / Page ${a.PlatPage}`);
    return lines.join('\n');
  }

  if (result.fetcher === 'fema-flood') {
    const zone = String(d.floodZone ?? 'NOT MAPPED');
    const inSFHA = d.inSpecialFloodHazardArea === true;
    const zoneLabel = floodZoneLabel(zone, inSFHA);
    const lines = [`:ocean: *FEMA flood zone* — ${zoneLabel}`];
    if (d.zoneSubtype) lines.push(`  • Subtype: ${d.zoneSubtype}`);
    if (d.baseFloodElevation != null) lines.push(`  • Base flood elevation: ${d.baseFloodElevation} ft`);
    if (d.firmPanel) lines.push(`  • FIRM panel: ${d.firmPanel}`);
    if (d.firmPanelEffectiveDate) {
      const dt = new Date(d.firmPanelEffectiveDate as number);
      if (!isNaN(dt.getTime())) lines.push(`  • FIRM effective: ${dt.toLocaleDateString('en-US')}`);
    }
    return lines.join('\n');
  }

  if (result.fetcher === 'septic') {
    const onSeptic = d.onSeptic === true;
    const count = Number(d.recordCount ?? 0);
    const icon = onSeptic ? ':toilet:' : ':potable_water:';
    const statusLabel = onSeptic
      ? `On septic (${count} record${count === 1 ? '' : 's'})`
      : 'No septic records — likely public sewer';
    return `${icon} *Septic / sewer* — ${statusLabel}`;
  }

  // Artifact-only fetchers (PDFs): no inline text needed.
  return null;
}

/** Batch rendering for the in-process path — joins all fetcher results. */
function renderFindings(results: FetcherResult[]): string {
  return results.map(renderFetcherResult).filter(Boolean).join('\n\n');
}

function floodZoneLabel(zone: string, inSFHA: boolean): string {
  if (zone.startsWith('A') || zone.startsWith('V')) {
    return `:warning: *${zone}* — HIGH RISK (flood insurance typically required)`;
  }
  if (zone === 'X' || zone === 'C' || zone === 'B') {
    return `*${zone}* — minimal flood hazard`;
  }
  if (zone === 'NOT MAPPED') return 'not mapped by FEMA';
  return inSFHA ? `:warning: *${zone}* — in SFHA` : `*${zone}*`;
}

function renderSummary(
  p: CanonicalProperty,
  totals: { completed: number; total: number; failed: number; filesProduced: number },
  durationMs: number,
  runId: string,
): string {
  const secs = (durationMs / 1000).toFixed(1);
  const statusEmoji = totals.failed === 0 ? ':checkered_flag:' : totals.completed > 0 ? ':warning:' : ':x:';
  const traceLink = PUBLIC_BASE_URL
    ? `<${PUBLIC_BASE_URL}/api/runs/${runId}|full trace>`
    : `run \`${runId.slice(0, 8)}\``;
  let text = `${statusEmoji} *Done for ${p.pin}* — ${totals.completed}/${totals.total} fetchers, ${secs}s — ${traceLink}`;
  if (totals.failed > 0) text += `\n_${totals.failed} fetcher(s) failed — see errors above._`;
  return text;
}

function chooseInput(
  text: string,
  channelName?: string,
): { raw: string; source: 'argument' | 'channel-name' } | null {
  const trimmed = text.trim();
  if (trimmed && !isMentionOnly(trimmed)) {
    return { raw: stripBotMention(trimmed), source: 'argument' };
  }
  if (channelName) {
    const guess = inferPropertyFromChannelName(channelName);
    if (guess.confident && guess.guess) {
      return { raw: guess.guess, source: 'channel-name' };
    }
  }
  return null;
}

function isMentionOnly(text: string): boolean {
  return /^<@[UW][A-Z0-9]+(\|[^>]+)?>\s*$/.test(text.trim());
}

function stripBotMention(text: string): string {
  return text.replace(/^<@[UW][A-Z0-9]+(\|[^>]+)?>\s*/, '').trim();
}

function progressEmoji(status: ProgressEvent['status']): string {
  switch (status) {
    case 'started':   return ':hourglass_flowing_sand:';
    case 'progress':  return ':hourglass_flowing_sand:';
    case 'completed': return ':white_check_mark:';
    case 'skipped':   return ':fast_forward:';
    case 'failed':    return ':x:';
  }
}

/**
 * Truncate an error string so it never blows a Slack 4000-char block limit.
 * Appends a byte-count suffix so the reader knows content was cut.
 */
function truncateError(s: string | null | undefined, max = 500): string {
  if (!s) return 'unknown error';
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [+${s.length - max} chars]`;
}

/**
 * Retry a DB write once (2 s delay) before giving up. Used to guard
 * `finishRun()` against transient Neon flaps that would leave a run
 * permanently stuck in `status='running'`.
 */
async function retryOnce(
  fn: () => Promise<unknown>,
  hlog: ReturnType<typeof log.child>,
  label: string,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    hlog.warn(`${label}_retry`, { err: String(e) });
    await new Promise((r) => setTimeout(r, 2_000));
    await fn().catch((e2) => hlog.error(`${label}_failed_permanently`, { err: String(e2) }));
  }
}

// ---------------------------------------------------------------------------
// Fan-out orchestrator
// ---------------------------------------------------------------------------

interface FanOutDelivery {
  slack: WebClient;
  channelId: string;
  threadTs: string;
  artifactStore: ArtifactStore;
}

/**
 * Fan-out orchestrator: fires every active fetcher as a parallel HTTP call to
 * /api/fetchers/:id. As each settles, immediately:
 *   - updates the progress tracker message
 *   - posts inline findings (data fetchers: parcel-json, fema-flood, septic)
 *   - uploads produced artifacts to the thread (document fetchers: PDFs)
 *
 * This means each document appears in the thread the moment its fetcher
 * finishes, rather than waiting for the slowest fetcher. Total wall time
 * equals the slowest fetcher (~141 s) rather than a sequential sum.
 */
async function runFetchersFanOut(
  fetchers: Fetcher[],
  property: CanonicalProperty,
  recorder: ProvenanceRecorder,
  baseUrl: string,
  progressLines: Map<string, string>,
  flushProgress: () => Promise<void>,
  hlog: ReturnType<typeof log.child>,
  delivery: FanOutDelivery,
): Promise<FetcherResult[]> {
  const active = fetchers.filter((f) => f.counties.includes(property.county));
  await recorder.setFetchersPlanned(active.length);

  const internalToken = process.env.HENRY_INTERNAL_TOKEN;
  const { slack, channelId, threadTs, artifactStore } = delivery;

  // Show all fetchers as pending before any fires.
  for (const f of active) {
    progressLines.set(f.id, `${progressEmoji('started')} *${f.id}*`);
  }
  await flushProgress();

  const results = await Promise.all(
    active.map(async (f): Promise<FetcherResult> => {
      let result: FetcherResult;
      let artifacts: Artifact[] = [];

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
          // 280 s — the fetcher function itself aborts at 265 s, giving it
          // time to write the error row and respond before we give up.
          signal: AbortSignal.timeout(280_000),
        });

        if (!resp.ok) {
          throw new Error(`fetcher endpoint returned HTTP ${resp.status}`);
        }

        const data = (await resp.json()) as { result: FetcherResult; artifacts?: Artifact[] };
        result = data.result;
        // Only surface non-JSON artifacts (PDFs, images) to Slack.
        artifacts = (data.artifacts ?? []).filter((a) => a.contentType !== 'application/json');

        const errSuffix = result.error ? ` — \`${truncateError(result.error, 100)}\`` : '';
        progressLines.set(f.id, `${progressEmoji(result.status)} *${f.id}*${errSuffix}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        hlog.warn('fanout_call_failed', { fetcherId: f.id, err: msg });
        progressLines.set(f.id, `${progressEmoji('failed')} *${f.id}* — \`${truncateError(msg, 100)}\``);
        result = { fetcher: f.id, status: 'failed', files: [], error: msg, durationMs: 0 };
      }

      // Update progress board.
      flushProgress().catch((e) => hlog.warn('progress_flush_failed', { err: String(e) }));

      // Post inline findings for data-only fetchers (and failures).
      const findingsText = renderFetcherResult(result);
      if (findingsText) {
        await slack.chat.postMessage({
          channel: channelId,
          thread_ts: threadTs,
          text: findingsText,
          mrkdwn: true,
        }).catch((e) => hlog.warn('findings_post_failed', { fetcherId: f.id, err: String(e) }));
      }

      // Upload each artifact as its own separate Slack message.
      for (const artifact of artifacts) {
        await uploadSingleArtifact(slack, channelId, threadTs, artifact, artifactStore, hlog);
      }

      return result;
    }),
  );

  return results;
}

// ---------------------------------------------------------------------------
// Artifact upload
// ---------------------------------------------------------------------------

/**
 * Upload one artifact as its own Slack file upload in the thread.
 * Each document gets a separate message so users can react, download,
 * and reference them individually.
 */
async function uploadSingleArtifact(
  slack: WebClient,
  channel: string,
  threadTs: string,
  artifact: Artifact,
  artifactStore: ArtifactStore,
  hlog: ReturnType<typeof log.child>,
): Promise<void> {
  try {
    const bytes = await artifactStore.get(artifact.storageUri);
    // Derive a clean filename from the storage URI path component.
    const filename = artifact.storageUri.split('/').pop()?.split('?')[0] ?? 'file';
    await slack.filesUploadV2({
      channel_id: channel,
      thread_ts: threadTs,
      file: bytes,
      filename,
      title: artifact.label,
    });
  } catch (e) {
    hlog.warn('artifact_upload_failed', { label: artifact.label, err: String(e) });
    await slack.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: `:warning: Could not upload \`${artifact.label}\`: ${truncateError(String(e), 200)}`,
    }).catch(() => undefined);
  }
}
