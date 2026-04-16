/**
 * Vercel API route: POST /api/slack/events
 *
 * Slack Events API endpoint. We subscribe to:
 *   - app_mention      (user types "@henry …" in any channel the bot is in)
 *   - url_verification (one-time handshake when we register the endpoint)
 *
 * INSTALLATION NOTE: `@henry` works from any channel the bot has been
 * invited to. For workspace-wide visibility, invite the bot via the App
 * Directory / "Add apps to channel" or use a workspace-wide default.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { WebClient } from '@slack/web-api';
import { verifySlackSignature } from '../../src/slack/signature.js';
import { handleHenryInvocation } from '../../src/slack/handler.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { log } from '../../src/lib/log.js';

export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

interface SlackEvent {
  type: string;
  team_id?: string;
  challenge?: string;
  event?: {
    type: string;
    user?: string;
    text?: string;
    channel?: string;
    ts?: string;
    thread_ts?: string;
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!signingSecret || !botToken) {
    res.status(500).send('Slack credentials not configured');
    return;
  }

  const rawBody = await readRawBody(req);
  const timestamp = req.headers['x-slack-request-timestamp'];
  const signature = req.headers['x-slack-signature'];
  const ok = verifySlackSignature({
    signingSecret,
    timestamp: Array.isArray(timestamp) ? timestamp[0] : timestamp,
    signature: Array.isArray(signature) ? signature[0] : signature,
    rawBody,
  });
  if (!ok) {
    res.status(401).send('Invalid signature');
    return;
  }

  let body: SlackEvent;
  try {
    body = JSON.parse(rawBody);
  } catch {
    res.status(400).send('Bad JSON');
    return;
  }

  // URL verification handshake
  if (body.type === 'url_verification' && body.challenge) {
    res.status(200).setHeader('content-type', 'text/plain').send(body.challenge);
    return;
  }

  if (body.type !== 'event_callback' || !body.event) {
    res.status(200).send('');
    return;
  }
  const ev = body.event;
  if (ev.type !== 'app_mention' || !ev.channel || !ev.user) {
    res.status(200).send('');
    return;
  }

  // Pre-establish DB connection while the request is still active.
  const provenanceStack = await makeProvenanceStack();

  // ACK — Slack requires a response within 3 s.
  res.status(200).send('');

  // waitUntil() keeps the function alive with full network access after the ACK.
  const slack = new WebClient(botToken);
  waitUntil(
    (async () => {
      let channelName: string | undefined;
      try {
        const info = await slack.conversations.info({ channel: ev.channel! });
        channelName = (info.channel as { name?: string } | undefined)?.name;
      } catch (e) {
        log.warn('channel_info_failed', { err: String(e) });
      }
      await handleHenryInvocation({
        trigger: 'slack-mention',
        teamId: body.team_id,
        text: ev.text ?? '',
        channelId: ev.channel!,
        channelName,
        userId: ev.user!,
        threadTs: ev.thread_ts ?? ev.ts,
        slack,
        provenanceStack,
      });
    })().catch((err) => {
      log.error('henry_invocation_failed', { err: String(err) });
    }),
  );
}
