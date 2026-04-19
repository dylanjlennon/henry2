import {
  Body, Container, Head, Heading, Html, Preview, Text, Hr, Link, Section, Row, Column,
} from '@react-email/components';
import * as React from 'react';

export interface ReportArtifact {
  label: string;
  contentType: string;
  bytes: number;
  storageUri: string;
}

export interface ReportFindings {
  floodZone?: string;
  floodZoneSubtype?: string;
  strEligible?: boolean | null;
  strJurisdiction?: string;
  onSeptic?: boolean;
  taxValue?: string;
  acreage?: number;
  deedBook?: string;
  deedPage?: string;
}

interface PropertyReportResultsProps {
  address: string;
  pin: string;
  ownerName?: string | null;
  durationMs: number | null;
  fetchersCompleted: number;
  fetchersTotal: number;
  artifacts: ReportArtifact[];
  findings: ReportFindings;
  webUrl: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCurrency(value: string | undefined): string {
  if (!value) return '—';
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);
}

const HIGH_RISK_ZONES = new Set(['AE', 'A', 'AO', 'AH', 'A1', 'A99', 'VE', 'V', 'V1']);

export default function PropertyReportResults({
  address,
  pin,
  ownerName,
  durationMs,
  fetchersCompleted,
  fetchersTotal,
  artifacts,
  findings,
  webUrl,
}: PropertyReportResultsProps) {
  const durationSec = durationMs ? (durationMs / 1000).toFixed(0) : '?';
  const pdfs = artifacts.filter((a) => a.contentType === 'application/pdf');

  const floodZone = findings.floodZone ?? '—';
  const isHighRisk = findings.floodZone
    ? HIGH_RISK_ZONES.has(findings.floodZone.toUpperCase().split(' ')[0])
    : false;
  const floodDisplay = findings.floodZoneSubtype
    ? `Zone ${floodZone} — ${findings.floodZoneSubtype}`
    : `Zone ${floodZone}`;

  const strDisplay =
    findings.strEligible === true ? 'Permitted' :
    findings.strEligible === false ? 'Not permitted' :
    findings.strJurisdiction ?? '—';

  const sewerDisplay =
    findings.onSeptic === true ? 'On septic' :
    findings.onSeptic === false ? 'Public sewer' : '—';

  return (
    <Html>
      <Head />
      <Preview>Henry report ready: {address}</Preview>
      <Body style={{ fontFamily: 'system-ui, -apple-system, sans-serif', background: '#f8f9fa', padding: '40px 0', margin: 0 }}>
        <Container style={{ background: '#ffffff', borderRadius: '8px', padding: '40px', maxWidth: '560px', margin: '0 auto' }}>

          {/* Header */}
          <Text style={{ color: '#718096', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '0 0 8px' }}>
            Henry Property Report
          </Text>
          <Heading style={{ fontSize: '22px', fontWeight: 600, margin: '0 0 4px', color: '#1a202c', lineHeight: '1.3' }}>
            {address}
          </Heading>
          <Text style={{ color: '#718096', fontSize: '13px', fontFamily: 'monospace', margin: '0 0 4px' }}>
            PIN: {pin}
          </Text>
          {ownerName && (
            <Text style={{ color: '#4a5568', fontSize: '14px', margin: '0 0 24px' }}>
              {ownerName}
            </Text>
          )}
          <Text style={{ color: '#a0aec0', fontSize: '12px', margin: '0 0 32px' }}>
            {fetchersCompleted}/{fetchersTotal} sources · {durationSec}s
          </Text>

          <Hr style={{ borderColor: '#e2e8f0', margin: '0 0 28px' }} />

          {/* Key findings */}
          <Text style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#a0aec0', margin: '0 0 14px' }}>
            Key Findings
          </Text>
          <Section style={{ background: '#f7fafc', borderRadius: '6px', padding: '4px 0', marginBottom: '28px' }}>
            <Row style={{ padding: '10px 16px' }}>
              <Column style={{ width: '40%' }}>
                <Text style={{ fontSize: '12px', color: '#718096', margin: 0 }}>Flood Zone</Text>
              </Column>
              <Column>
                <Text style={{ fontSize: '14px', fontWeight: 500, color: isHighRisk ? '#9B3A3A' : '#2E6B4F', margin: 0 }}>
                  {floodDisplay}
                </Text>
              </Column>
            </Row>
            <Row style={{ padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
              <Column style={{ width: '40%' }}>
                <Text style={{ fontSize: '12px', color: '#718096', margin: 0 }}>STR</Text>
              </Column>
              <Column>
                <Text style={{ fontSize: '14px', fontWeight: 500, color: findings.strEligible === false ? '#A8621F' : '#1a202c', margin: 0 }}>
                  {strDisplay}
                </Text>
              </Column>
            </Row>
            <Row style={{ padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
              <Column style={{ width: '40%' }}>
                <Text style={{ fontSize: '12px', color: '#718096', margin: 0 }}>Sewer</Text>
              </Column>
              <Column>
                <Text style={{ fontSize: '14px', fontWeight: 500, color: '#1a202c', margin: 0 }}>
                  {sewerDisplay}
                </Text>
              </Column>
            </Row>
            {findings.taxValue && (
              <Row style={{ padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
                <Column style={{ width: '40%' }}>
                  <Text style={{ fontSize: '12px', color: '#718096', margin: 0 }}>Assessed Value</Text>
                </Column>
                <Column>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: '#1a202c', margin: 0 }}>
                    {formatCurrency(findings.taxValue)}
                  </Text>
                </Column>
              </Row>
            )}
            {findings.acreage != null && (
              <Row style={{ padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
                <Column style={{ width: '40%' }}>
                  <Text style={{ fontSize: '12px', color: '#718096', margin: 0 }}>Acreage</Text>
                </Column>
                <Column>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: '#1a202c', margin: 0 }}>
                    {findings.acreage.toFixed(2)} ac
                  </Text>
                </Column>
              </Row>
            )}
            {findings.deedBook && findings.deedPage && (
              <Row style={{ padding: '10px 16px', borderTop: '1px solid #e2e8f0' }}>
                <Column style={{ width: '40%' }}>
                  <Text style={{ fontSize: '12px', color: '#718096', margin: 0 }}>Deed</Text>
                </Column>
                <Column>
                  <Text style={{ fontSize: '14px', fontWeight: 500, color: '#1a202c', margin: 0 }}>
                    Book {findings.deedBook} / Page {findings.deedPage}
                  </Text>
                </Column>
              </Row>
            )}
          </Section>

          {/* Documents */}
          {pdfs.length > 0 && (
            <>
              <Text style={{ fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#a0aec0', margin: '0 0 14px' }}>
                Documents ({pdfs.length})
              </Text>
              {pdfs.map((artifact) => (
                <Row key={artifact.storageUri} style={{ marginBottom: '8px' }}>
                  <Column style={{ width: '70%' }}>
                    <Text style={{ fontSize: '14px', color: '#1a202c', margin: 0 }}>
                      {artifact.label}
                    </Text>
                    <Text style={{ fontSize: '12px', color: '#a0aec0', margin: '2px 0 0' }}>
                      PDF · {formatBytes(artifact.bytes)}
                    </Text>
                  </Column>
                  <Column style={{ textAlign: 'right' as const }}>
                    <Link href={artifact.storageUri} style={{ fontSize: '13px', color: '#1F6DA6', textDecoration: 'none', fontWeight: 500 }}>
                      Download →
                    </Link>
                  </Column>
                </Row>
              ))}
              <Hr style={{ borderColor: '#e2e8f0', margin: '24px 0' }} />
            </>
          )}

          {/* Web link */}
          <Text style={{ color: '#4a5568', fontSize: '14px', margin: '0 0 24px' }}>
            View the full interactive report at:{' '}
            <Link href={webUrl} style={{ color: '#1F6DA6' }}>{webUrl}</Link>
          </Text>

          <Hr style={{ borderColor: '#e2e8f0', margin: '0 0 16px' }} />
          <Text style={{ color: '#a0aec0', fontSize: '11px', lineHeight: '16px', margin: 0 }}>
            Henry · Buncombe County Property Research · Data sourced from public county records.
            For informational purposes only — not legal, financial, or professional advice.
            Verify all information independently before making decisions.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
