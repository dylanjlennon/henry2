'use client';

import React from 'react';
import type { WebRunStatus, FemaFloodData, SepticData } from '@/types/property';

interface KeyFindingsProps {
  fetcherData: WebRunStatus['fetcherData'];
}

interface Stat {
  label: string;
  value: string;
  tone: 'calm' | 'risk' | 'neutral';
}

const HIGH_RISK_ZONES = new Set(['AE', 'A', 'AO', 'AH', 'A1', 'A99', 'VE', 'V', 'V1']);

export default function KeyFindings({ fetcherData }: KeyFindingsProps) {
  const fema = fetcherData['fema-flood'] as unknown as FemaFloodData | undefined;
  const septic = fetcherData['septic'] as unknown as SepticData | undefined;

  const stats: Stat[] = [];

  if (fema) {
    const zone = fema.floodZone ?? 'Unknown';
    const isHighRisk = zone !== 'X' && zone !== 'X500' && zone !== 'Unknown' && HIGH_RISK_ZONES.has(zone.toUpperCase().split(' ')[0]);
    const subtype = fema.zoneSubtype;
    const valueStr = subtype
      ? `Zone ${zone} — ${subtype.toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}`
      : `Zone ${zone}`;
    stats.push({ label: 'Flood Zone', value: valueStr, tone: isHighRisk ? 'risk' : 'calm' });
  }

  if (septic !== undefined) {
    stats.push({ label: 'Sewer', value: septic.onSeptic ? 'On septic' : 'Public sewer', tone: 'neutral' });
  }

  if (stats.length === 0) return null;

  return (
    <div style={{ maxWidth: '720px', margin: '0 auto', padding: '16px 16px 0' }}>
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        border: '1px solid var(--color-rule)',
        borderRadius: 'var(--radius-lg)',
        overflow: 'hidden',
        backgroundColor: 'var(--color-surface)',
      }}>
        {stats.map((stat, i) => {
          const valueColor =
            stat.tone === 'risk' ? 'var(--color-risk)' :
            stat.tone === 'calm' ? 'var(--color-calm)' :
            'var(--color-ink)';
          return (
            <div
              key={stat.label}
              style={{
                flex: '1 1 160px',
                padding: '14px 20px',
                borderLeft: i > 0 ? '1px solid var(--color-rule)' : undefined,
              }}
            >
              <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-faint)', fontWeight: 500, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: '4px' }}>
                {stat.label}
              </div>
              <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: valueColor }}>
                {stat.value}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
