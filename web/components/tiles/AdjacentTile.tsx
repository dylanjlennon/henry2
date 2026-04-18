'use client';

import React from 'react';
import ContextTile from '@/components/ContextTile';
import type { AdjacentParcelsData } from '@/types/property';

interface AdjacentTileProps {
  fetcherData: Record<string, Record<string, unknown>>;
  expanded: boolean;
  onToggle: () => void;
}

export default function AdjacentTile({ fetcherData, expanded, onToggle }: AdjacentTileProps) {
  const raw = fetcherData['adjacent-parcels'] as unknown as AdjacentParcelsData | undefined;

  const headline = raw ? `${raw.count} neighboring parcel${raw.count !== 1 ? 's' : ''}` : null;

  const subline = raw && raw.neighbors.length > 0
    ? raw.neighbors
        .slice(0, 2)
        .map((n) => n.owner)
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <ContextTile
      label="ADJACENT PARCELS"
      headline={headline}
      subline={subline}
      expanded={expanded}
      onToggle={onToggle}
      tone="default"
    >
      {raw && raw.neighbors.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 'var(--font-size-label)',
            }}
          >
            <thead>
              <tr>
                {['Owner', 'Address', 'Zoning'].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      padding: '4px 8px 6px 0',
                      fontWeight: 500,
                      color: 'var(--color-ink)',
                      borderBottom: '1px solid var(--color-rule)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {raw.neighbors.map((n, i) => (
                <tr key={n.pin || i}>
                  <td style={{ padding: '4px 8px 4px 0', verticalAlign: 'top' }}>{n.owner || '—'}</td>
                  <td style={{ padding: '4px 8px 4px 0', verticalAlign: 'top' }}>
                    {n.address || '—'}
                    {n.city ? `, ${n.city}` : ''}
                  </td>
                  <td style={{ padding: '4px 0 4px 0', verticalAlign: 'top', whiteSpace: 'nowrap' }}>
                    {n.zoningCode || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {raw && raw.neighbors.length === 0 && (
        <div style={{ color: 'var(--color-muted)' }}>No adjacent parcel data available</div>
      )}
    </ContextTile>
  );
}
