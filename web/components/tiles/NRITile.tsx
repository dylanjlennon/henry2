'use client';

import React from 'react';
import ContextTile from '@/components/ContextTile';
import type { NationalRiskIndexData } from '@/types/property';

interface NRITileProps {
  fetcherData: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
}

export default function NRITile({ fetcherData, expanded, onToggle }: NRITileProps) {
  const raw = fetcherData['national-risk-index'] as unknown as NationalRiskIndexData | undefined;

  const headline = raw
    ? raw.compositeRating
      ? `${raw.compositeRating} overall`
      : 'No data'
    : null;

  const subline = raw
    ? raw.topHazards.length > 0
      ? `Elevated: ${raw.topHazards.slice(0, 3).join(', ')}`
      : 'No elevated hazards'
    : null;

  return (
    <ContextTile
      label="NATIONAL RISK INDEX"
      headline={headline}
      subline={subline}
      expanded={expanded}
      onToggle={onToggle}
      tone="default"
    >
      {raw && (
        <div>
          <dl style={{ margin: '0 0 12px', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
            <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Composite score</dt>
            <dd style={{ margin: 0 }}>{raw.compositeScore ?? '—'}</dd>
            <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Rating</dt>
            <dd style={{ margin: 0 }}>{raw.compositeRating ?? '—'}</dd>
          </dl>
          {raw.topHazards.length > 0 && (
            <>
              <div style={{ fontWeight: 500, color: 'var(--color-ink)', marginBottom: '6px' }}>
                Top hazards
              </div>
              <ul style={{ margin: 0, padding: '0 0 0 16px' }}>
                {raw.topHazards.map((h, i) => (
                  <li key={i} style={{ marginBottom: '2px' }}>
                    {h}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </ContextTile>
  );
}
