'use client';

import React, { useId } from 'react';
import { ChevronRight } from 'lucide-react';
import Pill from '@/components/Pill';

export interface ContextTileProps {
  label: string;
  headline: string | null;
  subline?: string | null;
  expanded?: boolean;
  onToggle?: () => void;
  children?: React.ReactNode;
  tone?: 'default' | 'risk';
  error?: boolean;
}

function SkeletonBar({ width }: { width: string }) {
  return (
    <div
      style={{
        width,
        height: '4px',
        backgroundColor: 'var(--color-sunken)',
        borderRadius: '2px',
        marginBottom: '6px',
      }}
    />
  );
}

export default function ContextTile({
  label,
  headline,
  subline,
  expanded = false,
  onToggle,
  children,
  tone = 'default',
  error = false,
}: ContextTileProps) {
  const contentId = useId();
  const isLoading = headline === null;

  const borderColor =
    tone === 'risk'
      ? 'var(--color-risk)'
      : expanded
      ? 'var(--color-rule-strong)'
      : 'var(--color-rule)';

  return (
    <div
      style={{
        backgroundColor: expanded ? 'var(--color-sunken)' : 'var(--color-surface)',
        border: `1px solid ${borderColor}`,
        borderRadius: 'var(--radius-lg)',
        transition: 'border-color 150ms',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={contentId}
        disabled={!onToggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'flex-start',
          padding: '16px 20px',
          gap: '12px',
          background: 'none',
          border: 'none',
          cursor: onToggle ? 'pointer' : 'default',
          textAlign: 'left',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 'var(--font-size-caption)',
              fontWeight: 500,
              color: 'var(--color-faint)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginBottom: '6px',
            }}
          >
            {label}
          </div>

          {isLoading ? (
            <>
              <SkeletonBar width="80%" />
              <SkeletonBar width="60%" />
            </>
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  flexWrap: 'wrap',
                }}
              >
                {tone === 'risk' && (
                  <Pill tone="risk">Risk</Pill>
                )}
                <span
                  style={{
                    fontSize: 'var(--font-size-emphasis)',
                    fontWeight: 500,
                    color: error ? 'var(--color-muted)' : 'var(--color-ink)',
                    lineHeight: '22px',
                  }}
                >
                  {headline}
                </span>
              </div>
              {subline && (
                <div
                  style={{
                    fontSize: 'var(--font-size-label)',
                    color: 'var(--color-muted)',
                    marginTop: '2px',
                    lineHeight: '18px',
                  }}
                >
                  {subline}
                </div>
              )}
            </>
          )}
        </div>

        {onToggle && (
          <div
            style={{
              color: 'var(--color-faint)',
              flexShrink: 0,
              marginTop: '2px',
              transition: 'transform 200ms',
              transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            }}
          >
            <ChevronRight size={16} />
          </div>
        )}
      </button>

      {/* Expandable content using CSS grid for smooth animation */}
      <div
        id={contentId}
        style={{
          display: 'grid',
          gridTemplateRows: expanded ? '1fr' : '0fr',
          transition: 'grid-template-rows 200ms ease',
        }}
      >
        <div style={{ overflow: 'hidden' }}>
          {children && (
            <div
              style={{
                borderTop: '1px solid var(--color-rule)',
                padding: '16px 20px',
                fontSize: 'var(--font-size-body)',
                color: 'var(--color-muted)',
              }}
            >
              {children}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @media (prefers-reduced-motion: reduce) {
          * { transition: none !important; }
        }
      `}</style>
    </div>
  );
}
