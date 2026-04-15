/**
 * Shared Slack handler logic.
 *
 * Both the slash-command (`/henry …`) and the app-mention (`@henry …`)
 * entry points funnel into `handleHenryInvocation`, which:
 *   1. Resolves what property to research:
 *      - explicit argument text wins
 *      - otherwise fall back to channel-name inference
 *      - otherwise ask the user for input
 *   2. Opens an Invocation + Run in the provenance store.
 *   3. Posts an initial "on it" message (with thread_ts anchor).
 *   4. Kicks off the orchestrator; every fetcher, HTTP call, and produced
 *      artifact is recorded automatically.
 *   5. Streams progress to the thread, uploads produced files when done.
 *   6. Posts a summary line including the permanent run-trace URL.
 *
 * This module is transport-agnostic — it doesn't know whether Slack gave
 * us a slash command or a mention. That keeps it testable in isolation.
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { WebClient } from '@slack/web-api';
import { resolveProperty, ResolveError } from '../resolver/index.ts';
import { runFetchers } from '../orchestrator/index.ts';
import { ALL_FETCHERS } from '../orchestrator/fetchers.ts';
import { inferPropertyFromChannelName } from './channelName.ts';
import { log } from '../lib/log.ts';
import type { CanonicalProperty, ProgressEvent } from '../types.ts';
import { makeProvenanceStack } from '../provenance/factory.ts';
import { ProvenanceRecorder } from '../provenance/recorder.ts';
import { canonicalToSnapshot } from '../provenance/snapshot.ts';
import type { Invocation } from '../provenance/schema.ts';

export interface InvocationInput {
  /** Raw user-provided text ("" if none) */
  text: string;
  /** 'slack-slash' | 'slack-mention' */
  trigger: 'slack-slash' | 'slack-mention';
  /** Slack team id (T…) */
  teamId?: string;
  /** Channel the invocation came from */
  channelId: string;
  /** Channel NAME (e.g. "546-old-haw-creek-rd") — used for auto-detect */
  channelName?: string;
  /** User who invoked us */
  userId: string;
  /** Thread root to reply in. If undefined, bot creates a new thread. */
  threadTs?: string;
  /** Slack WebClient, already auth'd */
  slack: WebClient;
}

const OUT_ROOT = process.env.OUT_ROOT ?? join(tmpdir(), 'henry-runs');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? '';

export async function handleHenryInvocation(input: InvocationInput): Promise<void> {
  const { text, channelId, channelName, userId, slack } = input;

  // 1. Figure out the property input.
  const propertyInput = chooseInput(text, channelName);
  if (!propertyInput) {
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: input.threadTs,
      text:
        ":confused: I couldn't figure out what property to look up. Try `/henry 546 Old Haw Creek Rd` or `/henry 9648-65-1234-00000`.",
    });
    return;
  }

  // 2. Provenance: open an Invocation row now (before we even resolve).
  const { store, artifactStore, backendLabel } = await makeProvenanceStack();
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

  // 3. Post initial "on it" and capture thread_ts to reply in
  const posted = await slack.chat.postMessage({
    channel: channelId,
    thread_ts: input.threadTs,
    text: `:mag: Henry is looking up *${propertyInput.raw}*${
      propertyInput.source === 'channel-name' ? ` _(from this channel's name)_` : ''
    }…`,
  });
  const threadTs = input.threadTs ?? (posted.ts as string);

  // 4. Resolve
  let property: CanonicalProperty;
  try {
    property = await resolveProperty({ raw: propertyInput.raw, county: 'buncombe' });
  } catch (err) {
    const msg = err instanceof ResolveError ? err.message : (err as Error).message;
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:x: Couldn't resolve *${propertyInput.raw}*: ${msg}`,
    });
    hlog.warn('resolve_failed', { err: msg });
    return;
  }

  await recorder.startRun(canonicalToSnapshot(property));

  await slack.chat.postMessage({
    channel: channelId,
    thread_ts: threadTs,
    text: renderResolved(property, recorder.runId),
    mrkdwn: true,
  });

  // 5. Run fetchers with progress updates
  const progressLines: string[] = [];
  let lastPostTs: string | undefined;
  const flushProgress = async (): Promise<void> => {
    const text = progressLines.join('\n');
    if (lastPostTs) {
      await slack.chat.update({ channel: channelId, ts: lastPostTs, text });
    } else {
      const r = await slack.chat.postMessage({ channel: channelId, thread_ts: threadTs, text });
      lastPostTs = r.ts as string;
    }
  };

  const onProgress = (ev: ProgressEvent): void => {
    if (ev.fetcher === 'orchestrator' && ev.status === 'started') return;
    const emoji = progressEmoji(ev.status);
    const suffix = ev.message ? ` — ${ev.message}` : ev.error ? ` — ${ev.error}` : '';
    progressLines.push(`${emoji} *${ev.fetcher}*${suffix}`);
    flushProgress().catch((e) => hlog.warn('progress_flush_failed', { err: String(e) }));
  };

  let runStatus: 'completed' | 'partial' | 'failed' = 'completed';
  try {
    const summary = await runFetchers(ALL_FETCHERS, property, {
      outRoot: OUT_ROOT,
      onProgress,
      recorder,
    });

    if (summary.totals.failed > 0) runStatus = summary.totals.completed > 0 ? 'partial' : 'failed';

    // 6. Upload produced files
    const filesToUpload = summary.results.flatMap((r) =>
      r.files.map((f) => ({ path: f.path, title: `${r.fetcher}: ${f.label}` })),
    );
    if (filesToUpload.length > 0) {
      await uploadFiles(slack, channelId, threadTs, filesToUpload);
    }

    // 7. Final summary
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: renderSummary(property, summary.totals, summary.durationMs, recorder.runId),
      mrkdwn: true,
    });
  } catch (err) {
    runStatus = 'failed';
    hlog.error('run_error', { err: String(err) });
    await slack.chat.postMessage({
      channel: channelId,
      thread_ts: threadTs,
      text: `:x: Run failed: ${(err as Error).message}`,
    });
  } finally {
    await recorder.finishRun({ status: runStatus });
    hlog.info('run_closed', { status: runStatus });
  }
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

/** True if the text is just a bot mention like "<@U12345>" with nothing else */
function isMentionOnly(text: string): boolean {
  return /^<@[UW][A-Z0-9]+(\|[^>]+)?>\s*$/.test(text.trim());
}

/** Strip a leading bot mention like "<@U12345> 546 Old Haw …" → "546 Old Haw …" */
function stripBotMention(text: string): string {
  return text.replace(/^<@[UW][A-Z0-9]+(\|[^>]+)?>\s*/, '').trim();
}

function progressEmoji(status: ProgressEvent['status']): string {
  switch (status) {
    case 'started': return ':hourglass_flowing_sand:';
    case 'progress': return ':hourglass_flowing_sand:';
    case 'completed': return ':white_check_mark:';
    case 'skipped': return ':fast_forward:';
    case 'failed': return ':x:';
  }
}

function renderResolved(p: CanonicalProperty, runId: string): string {
  const lines = [`:pushpin: *${p.pin}*`];
  if (p.address) lines.push(`  • Address: ${p.address}`);
  if (p.ownerName) lines.push(`  • Owner: ${p.ownerName}`);
  if (p.deed) lines.push(`  • Deed: Book ${p.deed.book} Page ${p.deed.page}`);
  if (p.plat) lines.push(`  • Plat: Book ${p.plat.book} Page ${p.plat.page}`);
  lines.push(`  • Source: ${p.source} (confidence ${(p.confidence * 100).toFixed(0)}%)`);
  if (PUBLIC_BASE_URL) {
    lines.push(`  • Run: <${PUBLIC_BASE_URL}/api/runs/${runId}|${runId.slice(0, 8)}>`);
  } else {
    lines.push(`  • Run: \`${runId}\``);
  }
  return lines.join('\n');
}

function renderSummary(
  p: CanonicalProperty,
  totals: { completed: number; total: number; failed: number; filesProduced: number },
  durationMs: number,
  runId: string,
): string {
  const secs = (durationMs / 1000).toFixed(1);
  const traceLink = PUBLIC_BASE_URL
    ? ` — <${PUBLIC_BASE_URL}/api/runs/${runId}|full trace>`
    : ` — run \`${runId}\``;
  return (
    `:checkered_flag: Done for *${p.pin}* — ${totals.completed}/${totals.total} fetchers succeeded, ` +
    `${totals.filesProduced} files attached, ${secs}s${traceLink}.${
      totals.failed > 0 ? ` _${totals.failed} fetcher(s) failed; see above._` : ''
    }`
  );
}

async function uploadFiles(
  slack: WebClient,
  channel: string,
  threadTs: string,
  files: Array<{ path: string; title: string }>,
): Promise<void> {
  for (const f of files) {
    try {
      await slack.filesUploadV2({
        channel_id: channel,
        thread_ts: threadTs,
        file: await readFile(f.path),
        filename: f.path.split('/').pop() ?? 'file',
        title: f.title,
      });
    } catch (e) {
      log.warn('file_upload_failed', { path: f.path, err: String(e) });
    }
  }
}
