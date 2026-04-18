'use client';

import React from 'react';
import ContextTile from '@/components/ContextTile';
import type { HistoricDistrictData } from '@/types/property';

interface HistoricTileProps {
  fetcherData: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
}

export default function HistoricTile({ fetcherData, expanded, onToggle }: HistoricTileProps) {
  const raw = fetcherData['historic-district'] as unknown as HistoricDistrictData | undefined;

  const headline = raw
    ? raw.inLocalHistoricDistrict
      ? `In ${raw.districtName ?? 'Local Historic District'}`
      : 'No historic designation'
    : null;

  const subline = raw
    ? raw.inLocalHistoricDistrict
      ? 'Exterior changes require HPC Certificate of Appropriateness'
      : ''
    : null;

  return (
    <ContextTile
      label="HISTORIC DISTRICT"
      headline={headline}
      subline={subline}
      expanded={expanded}
      onToggle={onToggle}
      tone="default"
    >
      {raw && (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
          {raw.districtName && (
            <>
              <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>District</dt>
              <dd style={{ margin: 0 }}>{raw.districtName}</dd>
            </>
          )}
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Layer checked</dt>
          <dd style={{ margin: 0 }}>{raw.layerChecked}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Status</dt>
          <dd style={{ margin: 0 }}>
            {raw.inLocalHistoricDistrict ? 'In local historic district' : 'Not in historic district'}
          </dd>
        </dl>
      )}
    </ContextTile>
  );
}
