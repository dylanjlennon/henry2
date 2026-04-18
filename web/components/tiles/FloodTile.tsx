'use client';

import React from 'react';
import ContextTile from '@/components/ContextTile';
import type { FemaFloodData } from '@/types/property';

interface FloodTileProps {
  fetcherData: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
}

const ZONE_DESCRIPTIONS: Record<string, string> = {
  X: 'Minimal flood risk',
  AE: 'High risk — 1% annual chance',
  A: 'High risk',
  VE: 'Coastal high risk',
  V: 'Coastal high risk',
};

function zoneDescription(zone: string | null): string {
  if (!zone) return '';
  return ZONE_DESCRIPTIONS[zone] ?? 'Check FEMA FIRM';
}

export default function FloodTile({ fetcherData, expanded, onToggle }: FloodTileProps) {
  const raw = fetcherData['fema-flood'] as unknown as FemaFloodData | undefined;

  const headline = raw
    ? raw.floodZone
      ? `Zone ${raw.floodZone} · ${zoneDescription(raw.floodZone)}`
      : 'No flood data'
    : null;

  const subline = raw && raw.firmPanel ? `FIRM Panel: ${raw.firmPanel}` : null;
  const tone = raw && raw.sfha === true ? 'risk' as const : 'default' as const;

  return (
    <ContextTile
      label="FEMA FLOOD ZONE"
      headline={headline}
      subline={subline}
      expanded={expanded}
      onToggle={onToggle}
      tone={tone}
    >
      {raw && (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Flood zone</dt>
          <dd style={{ margin: 0 }}>{raw.floodZone ?? '—'}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>SFHA</dt>
          <dd style={{ margin: 0 }}>
            {raw.sfha === true ? 'Yes — Special Flood Hazard Area' : raw.sfha === false ? 'No' : '—'}
          </dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>FIRM panel</dt>
          <dd style={{ margin: 0 }}>{raw.firmPanel ?? '—'}</dd>
        </dl>
      )}
    </ContextTile>
  );
}
