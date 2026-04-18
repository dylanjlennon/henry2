'use client';

import React from 'react';
import { ArrowUpRight } from 'lucide-react';

interface ActionButton {
  label: string;
  onClick: () => void;
}

export default function ActionRow() {
  const actions: ActionButton[] = [
    {
      label: 'Draft MLS remarks',
      onClick: () => console.log('Draft MLS remarks'),
    },
    {
      label: 'Build disclosure list',
      onClick: () => console.log('Build disclosure list'),
    },
    {
      label: 'Find comps',
      onClick: () => console.log('Find comps'),
    },
    {
      label: 'Export PDF',
      onClick: () => window.print(),
    },
  ];

  return (
    <div
      style={{
        maxWidth: '720px',
        margin: '0 auto',
        padding: '0 16px 32px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '8px',
      }}
    >
      {actions.map((action) => (
        <button
          key={action.label}
          onClick={action.onClick}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '7px 14px',
            backgroundColor: 'var(--color-surface)',
            border: '1px solid var(--color-rule)',
            borderRadius: 'var(--radius-default)',
            fontSize: 'var(--font-size-body)',
            fontWeight: 400,
            color: 'var(--color-ink)',
            cursor: 'pointer',
            transition: 'border-color 150ms',
          }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-rule-strong)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--color-rule)')
          }
        >
          {action.label}
          <ArrowUpRight size={14} style={{ color: 'var(--color-faint)' }} />
        </button>
      ))}
    </div>
  );
}
