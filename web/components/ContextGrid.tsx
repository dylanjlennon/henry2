'use client';

import React, { useState } from 'react';
import HistoricTile from '@/components/tiles/HistoricTile';
import STRTile from '@/components/tiles/STRTile';
import LandslideTile from '@/components/tiles/LandslideTile';
import TerrainTile from '@/components/tiles/TerrainTile';
import FloodTile from '@/components/tiles/FloodTile';
import NRITile from '@/components/tiles/NRITile';
import SoilTile from '@/components/tiles/SoilTile';
import AdjacentTile from '@/components/tiles/AdjacentTile';

interface ContextGridProps {
  fetcherData: Record<string, Record<string, unknown>>;
  runStatus: string;
}

type TileId = 'historic' | 'str' | 'landslide' | 'terrain' | 'flood' | 'nri' | 'soil' | 'adjacent';

export default function ContextGrid({ fetcherData }: ContextGridProps) {
  const [expanded, setExpanded] = useState<Set<TileId>>(new Set());

  const toggle = (id: TileId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const tileProps = (id: TileId) => ({
    fetcherData,
    expanded: expanded.has(id),
    onToggle: () => toggle(id),
  });

  return (
    <div
      style={{
        maxWidth: '720px',
        margin: '0 auto',
        padding: '20px 16px',
        display: 'grid',
        gridTemplateColumns: 'repeat(2, 1fr)',
        gap: '12px',
      }}
    >
      <style>{`
        @media (max-width: 767px) {
          .context-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
      <HistoricTile {...tileProps('historic')} />
      <STRTile {...tileProps('str')} />
      <LandslideTile {...tileProps('landslide')} />
      <TerrainTile {...tileProps('terrain')} />
      <FloodTile {...tileProps('flood')} />
      <NRITile {...tileProps('nri')} />
      <SoilTile {...tileProps('soil')} />
      <AdjacentTile {...tileProps('adjacent')} />
    </div>
  );
}
