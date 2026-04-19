import { Resend } from 'resend';
import { render } from '@react-email/render';
import PropertyReportAck from '../emails/PropertyReportAck.js';
import PropertyReportResults, { type ReportArtifact, type ReportFindings } from '../emails/PropertyReportResults.js';
import { log } from './log.js';

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM = process.env.EMAIL_FROM ?? 'Henry <research@henryproperty.co>';

async function send(to: string, subject: string, html: string): Promise<void> {
  try {
    await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    log.error('email_send_failed', { to, subject, err: String(err) });
  }
}

export async function sendPropertyReportAck(opts: {
  to: string;
  address: string;
  pin: string;
}): Promise<void> {
  const html = await render(PropertyReportAck({ address: opts.address, pin: opts.pin }));
  await send(opts.to, `Henry is pulling records for ${opts.address}`, html);
}

export async function sendPropertyReportResults(opts: {
  to: string;
  address: string;
  pin: string;
  ownerName?: string | null;
  durationMs: number | null;
  fetchersCompleted: number;
  fetchersTotal: number;
  artifacts: ReportArtifact[];
  findings: ReportFindings;
  webUrl: string;
}): Promise<void> {
  const html = await render(PropertyReportResults(opts));
  await send(opts.to, `Henry report ready: ${opts.address}`, html);
}
