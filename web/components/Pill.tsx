'use client';

import React from 'react';

export type PillTone = 'neutral' | 'info' | 'warn' | 'risk' | 'calm';

const toneStyles: Record<PillTone, React.CSSProperties> = {
  neutral: {
    color: 'var(--color-muted)',
    backgroundColor: 'var(--color-sunken)',
  },
  info: {
    color: 'var(--color-info)',
    backgroundColor: 'var(--color-info-bg)',
  },
  warn: {
    color: 'var(--color-warn)',
    backgroundColor: 'var(--color-warn-bg)',
  },
  risk: {
    color: 'var(--color-risk)',
    backgroundColor: 'var(--color-risk-bg)',
  },
  calm: {
    color: 'var(--color-calm)',
    backgroundColor: 'var(--color-calm-bg)',
  },
};

interface PillProps {
  tone?: PillTone;
  children: React.ReactNode;
}

export default function Pill({ tone = 'neutral', children }: PillProps) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: '22px',
        padding: '0 10px',
        borderRadius: 'var(--radius-pill)',
        fontSize: 'var(--font-size-label)',
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        ...toneStyles[tone],
      }}
    >
      {children}
    </span>
  );
}
