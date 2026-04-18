'use client';

import React from 'react';
import ContextTile from '@/components/ContextTile';
import type { STREligibilityData } from '@/types/property';

interface STRTileProps {
  fetcherData: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
}

export default function STRTile({ fetcherData, expanded, onToggle }: STRTileProps) {
  const raw = fetcherData['str-eligibility'] as unknown as STREligibilityData | undefined;

  const headline = raw
    ? raw.summary.length > 80
      ? raw.summary.slice(0, 80) + '…'
      : raw.summary
    : null;

  const subline = raw
    ? raw.zoningDistrict
      ? `Zoning: ${raw.zoningDistrict}`
      : raw.rulesJurisdiction
    : null;

  const tone = raw && raw.eligible === false ? 'risk' as const : 'default' as const;

  return (
    <ContextTile
      label="SHORT-TERM RENTAL"
      headline={headline}
      subline={subline}
      expanded={expanded}
      onToggle={onToggle}
      tone={tone}
    >
      {raw && (
        <div>
          <p style={{ margin: '0 0 12px', color: 'var(--color-ink)', lineHeight: '20px' }}>
            {raw.summary}
          </p>
          {raw.activePermits.length > 0 && (
            <>
              <div style={{ fontWeight: 500, color: 'var(--color-ink)', marginBottom: '6px' }}>
                Active permits ({raw.activePermitCount})
              </div>
              <ul style={{ margin: 0, padding: '0 0 0 16px' }}>
                {raw.activePermits.map((permit, i) => (
                  <li key={i} style={{ marginBottom: '2px' }}>
                    {permit}
                  </li>
                ))}
              </ul>
            </>
          )}
          {raw.activePermits.length === 0 && (
            <div style={{ color: 'var(--color-muted)' }}>No active STR permits on record</div>
          )}
        </div>
      )}
    </ContextTile>
  );
}
