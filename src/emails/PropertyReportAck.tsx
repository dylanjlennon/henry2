import {
  Body, Container, Head, Heading, Html, Preview, Text, Hr,
} from '@react-email/components';
import * as React from 'react';

interface PropertyReportAckProps {
  address: string;
  pin: string;
}

export default function PropertyReportAck({ address, pin }: PropertyReportAckProps) {
  return (
    <Html>
      <Head />
      <Preview>Henry is pulling records for {address} — report in ~2 minutes</Preview>
      <Body style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#f8f9fa', padding: '40px 0', margin: 0 }}>
        <Container style={{ background: '#ffffff', borderRadius: '8px', padding: '40px', maxWidth: '520px', margin: '0 auto' }}>
          <Heading style={{ fontSize: '20px', fontWeight: 600, margin: '0 0 16px', color: '#1a202c' }}>
            Got it. Pulling records now.
          </Heading>
          <Text style={{ color: '#4a5568', lineHeight: '1.6', margin: '0 0 8px' }}>
            <strong>{address}</strong>
          </Text>
          <Text style={{ color: '#718096', fontSize: '13px', fontFamily: 'monospace', margin: '0 0 24px' }}>
            PIN: {pin}
          </Text>
          <Text style={{ color: '#4a5568', lineHeight: '1.6', margin: '0 0 24px' }}>
            Henry is searching 12 public data sources simultaneously — deed, tax bill, flood zone,
            permits, STR eligibility, soil, landslide hazard, and more. You'll have the full report
            in about 2 minutes.
          </Text>
          <Hr style={{ borderColor: '#e2e8f0', margin: '24px 0' }} />
          <Text style={{ color: '#a0aec0', fontSize: '12px', margin: 0 }}>
            Henry · Buncombe County Property Research · Data sourced from public county records.
            For informational purposes only — not legal or financial advice.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
