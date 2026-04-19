'use client';

import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { WebRunStatus } from '@/types/property';

const BACKEND_BASE = 'https://henry-slack.vercel.app';

interface ActionRowProps {
  artifacts: WebRunStatus['artifacts'];
}

export default function ActionRow({ artifacts }: ActionRowProps) {
  const pdfArtifacts = artifacts.filter((a) => a.contentType === 'application/pdf');

  const handleDownloadAll = () => {
    pdfArtifacts.forEach((a) => {
      window.open(`${BACKEND_BASE}/api/artifact/${a.id}`, '_blank');
    });
  };

  if (pdfArtifacts.length === 0) return null;

  return (
    <div
      style={{
        maxWidth: '720px',
        margin: '0 auto',
        padding: '0 16px 32px',
      }}
    >
      <button
        onClick={handleDownloadAll}
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
        Download All PDFs
        <ArrowUpRight size={14} style={{ color: 'var(--color-faint)' }} />
      </button>
    </div>
  );
}
