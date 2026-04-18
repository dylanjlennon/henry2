'use client';

import React from 'react';
import ContextTile from '@/components/ContextTile';
import type { SlopeData } from '@/types/property';

interface TerrainTileProps {
  fetcherData: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
}

function slopeSubline(pct: number | null): string {
  if (pct === null) return '';
  if (pct > 25) return 'Steep terrain — verify buildability';
  if (pct > 15) return 'Moderate slope';
  return 'Relatively flat';
}

export default function TerrainTile({ fetcherData, expanded, onToggle }: TerrainTileProps) {
  const raw = fetcherData['slope'] as unknown as SlopeData | undefined;

  const elev = raw?.elevationFt != null ? `${raw.elevationFt} ft` : '—';
  const slope = raw?.slopePct != null ? `${raw.slopePct}% slope` : '—';

  const headline = raw ? `${elev} · ${slope}` : null;
  const subline = raw ? slopeSubline(raw.slopePct) : null;

  return (
    <ContextTile
      label="TERRAIN"
      headline={headline}
      subline={subline}
      expanded={expanded}
      onToggle={onToggle}
      tone="default"
    >
      {raw && (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Elevation</dt>
          <dd style={{ margin: 0 }}>{raw.elevationFt != null ? `${raw.elevationFt} ft` : '—'}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Slope</dt>
          <dd style={{ margin: 0 }}>{raw.slopePct != null ? `${raw.slopePct}%` : '—'}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Slope (degrees)</dt>
          <dd style={{ margin: 0 }}>{raw.slopeDeg != null ? `${raw.slopeDeg}°` : '—'}</dd>
        </dl>
      )}
    </ContextTile>
  );
}
