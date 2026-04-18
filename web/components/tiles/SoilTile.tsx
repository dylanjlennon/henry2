'use client';

import React from 'react';
import ContextTile from '@/components/ContextTile';
import type { SoilSepticData } from '@/types/property';

interface SoilTileProps {
  fetcherData: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
}

export default function SoilTile({ fetcherData, expanded, onToggle }: SoilTileProps) {
  const raw = fetcherData['soil-septic'] as unknown as SoilSepticData | undefined;

  const headline = raw ? raw.mapUnitName ?? 'Unknown soil unit' : null;

  const subline = raw
    ? raw.septicRating
      ? `Septic: ${raw.septicRating}`
      : raw.componentName ?? ''
    : null;

  const tone =
    raw && raw.septicRating && /very limited/i.test(raw.septicRating)
      ? 'risk' as const
      : 'default' as const;

  return (
    <ContextTile
      label="SOIL & SEPTIC"
      headline={headline}
      subline={subline}
      expanded={expanded}
      onToggle={onToggle}
      tone={tone}
    >
      {raw && (
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 16px' }}>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Map unit</dt>
          <dd style={{ margin: 0 }}>{raw.mapUnitName ?? '—'}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Component</dt>
          <dd style={{ margin: 0 }}>{raw.componentName ?? '—'}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Texture</dt>
          <dd style={{ margin: 0 }}>{raw.texture ?? '—'}</dd>
          <dt style={{ fontWeight: 500, color: 'var(--color-ink)' }}>Septic suitability</dt>
          <dd style={{ margin: 0 }}>{raw.septicRating ?? '—'}</dd>
        </dl>
      )}
    </ContextTile>
  );
}
