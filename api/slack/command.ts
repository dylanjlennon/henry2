/**
 * Vercel API route: POST /api/slack/command
 *
 * This is the target for the `/henry` slash command. Slack sends:
 *   application/x-www-form-urlencoded body with token, team_id, channel_id,
 *   channel_name, user_id, text, response_url, trigger_id, ...
 *
 * We must respond within 3 seconds. We acknowledge immediately with an
 * empty 200 and do the real work via waitUntil() so Vercel keeps the function
 * alive (with full network access) until the background promise resolves.
 *
 * INSTALLATION NOTE: Works from ANY channel in the workspace because the
 * slash command is workspace-scoped in the Slack app manifest.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { waitUntil } from '@vercel/functions';
import { WebClient } from '@slack/web-api';
import { verifySlackSignature } from '../../src/slack/signature.js';
import { handleHenryInvocation } from '../../src/slack/handler.js';
import { makeProvenanceStack } from '../../src/provenance/factory.js';
import { log } from '../../src/lib/log.js';

// Prevent Vercel from parsing the body — we need the raw string to verify the signature.
export const config = { api: { bodyParser: false } };

async function readRawBody(req: VercelRequest): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!signingSecret || !botToken) {
    log.error('slack_env_missing');
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
    log.warn('slack_signature_invalid');
    res.status(401).send('Invalid signature');
    return;
  }

  const params = new URLSearchParams(rawBody);
  const teamId = params.get('team_id') ?? undefined;
  const channelId = params.get('channel_id') ?? '';
  const channelName = params.get('channel_name') ?? undefined;
  const userId = params.get('user_id') ?? '';
  const text = params.get('text') ?? '';

  // Pre-establish the DB connection while the HTTP request is still active.
  const provenanceStack = await makeProvenanceStack();

  // ACK immediately — Slack requires a response within 3 s.
  res.status(200).send('');

  // waitUntil() keeps the Vercel function alive (with full network access)
  // until this promise settles, even though we already sent the response.
  const slack = new WebClient(botToken);
  waitUntil(
    handleHenryInvocation({
      trigger: 'slack-slash',
      teamId,
      text,
      channelId,
      channelName,
      userId,
      slack,
      provenanceStack,
    }).catch(async (err) => {
      log.error('henry_invocation_failed', { err: String(err) });
      await slack.chat
        .postMessage({ channel: channelId, text: `:boom: Henry crashed: ${String(err)}` })
        .catch(() => undefined);
    }),
  );
}
