'use client';

import React from 'react';
import ContextTile from '@/components/ContextTile';
import type { LandslideHazardData } from '@/types/property';

interface LandslideTileProps {
  fetcherData: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
}

function stabilityScore(index: number | null): number {
  if (index === null) return 0;
  const map: Record<number, number> = { 1: 10, 2: 6, 3: 2 };
  return map[index] ?? 0;
}

export default function LandslideTile({ fetcherData, expanded, onToggle }: LandslideTileProps) {
  const raw = fetcherData['landslide-hazard'] as unknown as LandslideHazardData | undefined;

  const headline = raw
    ? `${raw.stabilityLabel ?? 'Unknown'} · Stability ${stabilityScore(raw.stabilityIndex)}/10`
    : null;

  const subline = raw
    ? raw.debrisFlowCount > 0
      ? `${raw.debrisFlowCount} debris flow deposit(s) on parcel`
      : 'No debris flow deposits'
    : null;

  const tone =
    raw && (raw.riskLevel === 'high' || raw.debrisFlowCount > 0) ? 'risk' as const : 'default' as const;

  return (
    <ContextTile
      label="LANDSLIDE HAZARD"
      headline={headline}
      subline={subline}
      expanded={expanded}
      onToggle={onToggle}
      tone={tone}
    >
      {raw && (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Risk level</dt>
          <dd style={{ margin: 0, textTransform: 'capitalize' }}>{raw.riskLevel}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Stability index</dt>
          <dd style={{ margin: 0 }}>{raw.stabilityIndex ?? '—'}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Nearby landslides</dt>
          <dd style={{ margin: 0 }}>{raw.nearbyLandslideCount}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Slope movement</dt>
          <dd style={{ margin: 0 }}>{raw.slopeMovementCount}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Debris flow deposits</dt>
          <dd style={{ margin: 0 }}>{raw.debrisFlowCount}</dd>
        </dl>
      )}
    </ContextTile>
  );
}
