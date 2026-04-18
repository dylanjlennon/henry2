'use client';

import React from 'react';
import type {
  WebRunStatus,
  FemaFloodData,
  SepticData,
  STREligibilityData,
  ParcelJsonData,
} from '@/types/property';

interface KeyFindingsProps {
  fetcherData: WebRunStatus['fetcherData'];
}

type FindingTone = 'calm' | 'warn' | 'risk' | 'neutral';

interface Finding {
  label: string;
  value: string;
  tone: FindingTone;
}

const toneStyle: Record<FindingTone, React.CSSProperties> = {
  calm: { color: 'var(--color-calm)', backgroundColor: 'var(--color-calm-bg)' },
  warn: { color: 'var(--color-warn)', backgroundColor: 'var(--color-warn-bg)' },
  risk: { color: 'var(--color-risk)', backgroundColor: 'var(--color-risk-bg)' },
  neutral: { color: 'var(--color-muted)', backgroundColor: 'var(--color-sunken)' },
};

function formatCurrencyFromString(value: string | undefined | null): string {
  if (!value) return '—';
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(num);
}

const HIGH_RISK_ZONES = new Set(['AE', 'A', 'AO', 'AH', 'A1', 'A99', 'VE', 'V', 'V1']);

export default function KeyFindings({ fetcherData }: KeyFindingsProps) {
  const fema = fetcherData['fema-flood'] as unknown as FemaFloodData | undefined;
  const septic = fetcherData['septic'] as unknown as SepticData | undefined;
  const str = fetcherData['str-eligibility'] as unknown as STREligibilityData | undefined;
  const parcelJson = fetcherData['parcel-json'] as unknown as ParcelJsonData | undefined;
  const attrs = parcelJson?.attributes;

  const findings: Finding[] = [];

  // Flood zone
  if (fema) {
    const zone = fema.floodZone ?? 'Unknown';
    const isHighRisk = zone !== 'X' && zone !== 'X500' && zone !== 'Unknown' && HIGH_RISK_ZONES.has(zone.toUpperCase().split(' ')[0]);
    const subtype = fema.zoneSubtype;
    const valueStr = subtype
      ? `Zone ${zone} — ${subtype.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}`
      : `Zone ${zone}`;
    findings.push({
      label: 'Flood Zone',
      value: valueStr,
      tone: isHighRisk ? 'risk' : 'calm',
    });
  }

  // Sewer / Septic
  if (septic !== undefined) {
    findings.push({
      label: 'Sewer',
      value: septic.onSeptic ? 'On septic' : 'Public sewer',
      tone: 'neutral',
    });
  }

  // STR eligibility
  if (str !== undefined) {
    if (str.eligible === true) {
      findings.push({ label: 'STR', value: 'STR permitted', tone: 'calm' });
    } else if (str.eligible === false) {
      findings.push({ label: 'STR', value: 'STR not permitted', tone: 'warn' });
    } else if (str.rulesJurisdiction) {
      findings.push({ label: 'STR', value: str.rulesJurisdiction, tone: 'neutral' });
    }
  }

  // Assessed value
  if (attrs?.TaxValue) {
    findings.push({
      label: 'Assessed Value',
      value: formatCurrencyFromString(attrs.TaxValue),
      tone: 'neutral',
    });
  }

  // Deed reference
  if (attrs?.DeedBook && attrs?.DeedPage) {
    findings.push({
      label: 'Deed',
      value: `Book ${attrs.DeedBook} / Page ${attrs.DeedPage}`,
      tone: 'neutral',
    });
  }

  if (findings.length === 0) return null;

  return (
    <div
      style={{
        maxWidth: '720px',
        margin: '0 auto',
        padding: '0 16px 4px',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px',
        }}
      >
        {findings.map((finding) => (
          <div
            key={finding.label}
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: 'var(--radius-default)',
              fontSize: 'var(--font-size-body)',
              ...toneStyle[finding.tone],
            }}
          >
            <span
              style={{
                fontSize: 'var(--font-size-label)',
                fontWeight: 500,
                letterSpacing: '0.03em',
                textTransform: 'uppercase',
                opacity: 0.7,
              }}
            >
              {finding.label}
            </span>
            <span style={{ fontWeight: 500 }}>{finding.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
