'use client';

import React from 'react';
import type { WebRunStatus } from '@/types/property';

const BACKEND_BASE = 'https://henry-slack.vercel.app';

const KWCOMMAND_DOCS = [
  { match: /property record card/i, label: 'Property Record Card' },
  { match: /tax bill/i, label: 'Tax Bill' },
  { match: /deed/i, label: 'Deed' },
  { match: /plat/i, label: 'Plat' },
  { match: /gis parcel map/i, label: 'GIS Parcel Map' },
  { match: /firmette/i, label: 'FEMA FIRMette' },
  { match: /permits/i, label: 'Permits' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(contentType: string): string {
  if (contentType === 'application/pdf') return '📄';
  if (contentType === 'application/json') return '{}';
  if (contentType === 'text/csv') return '⊞';
  return '📄';
}

function fileTypeLabel(contentType: string): string {
  if (contentType === 'application/pdf') return 'PDF';
  if (contentType === 'application/json') return 'JSON';
  if (contentType === 'text/csv') return 'CSV';
  return contentType;
}

interface DocumentCardProps {
  artifact: { id: string; label: string; contentType: string; bytes: number };
}

function DocumentCard({ artifact }: DocumentCardProps) {
  const isPdf = artifact.contentType === 'application/pdf';
  const downloadUrl = `${BACKEND_BASE}/api/artifact/${artifact.id}`;

  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        border: '1px solid var(--color-rule)',
        borderRadius: 'var(--radius-default)',
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        transition: 'border-color 150ms',
      }}
      onMouseEnter={(e) => {
        if (isPdf) {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-info-bg)';
        } else {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-rule-strong)';
        }
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-rule)';
      }}
    >
      <span
        style={{
          fontSize: '18px',
          lineHeight: 1,
          flexShrink: 0,
          fontFamily: 'monospace',
          color: isPdf ? 'var(--color-info)' : 'var(--color-muted)',
        }}
      >
        {fileIcon(artifact.contentType)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 'var(--font-size-body)',
            fontWeight: 500,
            color: 'var(--color-ink)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {artifact.label}
        </div>
        <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-muted)', marginTop: '2px' }}>
          {formatBytes(artifact.bytes)} {fileTypeLabel(artifact.contentType)}
        </div>
      </div>
      <a
        href={downloadUrl}
        download
        target="_blank"
        rel="noreferrer"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '4px',
          padding: '5px 12px',
          backgroundColor: 'var(--color-sunken)',
          border: '1px solid var(--color-rule)',
          borderRadius: 'var(--radius-default)',
          fontSize: 'var(--font-size-label)',
          fontWeight: 400,
          color: 'var(--color-ink)',
          textDecoration: 'none',
          flexShrink: 0,
          whiteSpace: 'nowrap',
        }}
      >
        ↓ Download
      </a>
    </div>
  );
}

interface DocumentsPanelProps {
  artifacts: WebRunStatus['artifacts'];
  runStatus: string;
  fetcherStatuses: Record<string, string>;
}

export default function DocumentsPanel({ artifacts, runStatus, fetcherStatuses }: DocumentsPanelProps) {
  const isRunning = runStatus === 'running';

  // Build compliance checklist
  const checklist = KWCOMMAND_DOCS.map((doc) => {
    const found = artifacts.find((a) => doc.match.test(a.label));
    let state: 'present' | 'fetching' | 'missing';
    if (found) {
      state = 'present';
    } else if (isRunning) {
      state = 'fetching';
    } else {
      state = 'missing';
    }
    return { ...doc, state, artifactId: found?.id };
  });

  const presentCount = checklist.filter((c) => c.state === 'present').length;
  const totalRequired = KWCOMMAND_DOCS.length;

  return (
    <div
      style={{
        maxWidth: '720px',
        margin: '0 auto',
        padding: '20px 16px',
      }}
    >
      {/* Section label */}
      <div
        style={{
          fontSize: 'var(--font-size-label)',
          fontWeight: 500,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'var(--color-muted)',
          marginBottom: '12px',
        }}
      >
        Compliance Documents
      </div>

      {/* KWCommand checklist */}
      <div
        style={{
          backgroundColor: 'var(--color-sunken)',
          border: '1px solid var(--color-rule)',
          borderRadius: 'var(--radius-default)',
          padding: '12px 16px',
          marginBottom: '16px',
        }}
      >
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '8px 16px',
            marginBottom: '10px',
          }}
        >
          {checklist.map((item) => (
            <span
              key={item.label}
              style={{
                fontSize: 'var(--font-size-label)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                color:
                  item.state === 'present'
                    ? 'var(--color-calm)'
                    : item.state === 'fetching'
                    ? 'var(--color-muted)'
                    : 'var(--color-faint)',
              }}
            >
              {item.state === 'present' && (
                <span style={{ color: 'var(--color-calm)', fontWeight: 500 }}>✓</span>
              )}
              {item.state === 'fetching' && (
                <span
                  style={{
                    display: 'inline-block',
                    width: '10px',
                    height: '10px',
                    border: '1.5px solid var(--color-rule)',
                    borderTopColor: 'var(--color-muted)',
                    borderRadius: '50%',
                    animation: 'spin 0.7s linear infinite',
                    flexShrink: 0,
                  }}
                />
              )}
              {item.state === 'missing' && (
                <span style={{ color: 'var(--color-faint)' }}>–</span>
              )}
              {item.label}
            </span>
          ))}
        </div>
        <div
          style={{
            fontSize: 'var(--font-size-label)',
            color: presentCount === totalRequired ? 'var(--color-calm)' : 'var(--color-muted)',
            fontWeight: 500,
          }}
        >
          {isRunning
            ? `Fetching… ${presentCount}/${totalRequired} documents ready`
            : `${presentCount}/${totalRequired} documents ready`}
        </div>
      </div>

      {/* Document cards grid */}
      {artifacts.length === 0 && isRunning ? (
        <div
          style={{
            padding: '32px 16px',
            textAlign: 'center',
            color: 'var(--color-faint)',
            fontSize: 'var(--font-size-body)',
          }}
        >
          Documents will appear as they are fetched…
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, 1fr)',
            gap: '8px',
          }}
          className="docs-grid"
        >
          <style>{`
            @media (max-width: 600px) {
              .docs-grid { grid-template-columns: 1fr !important; }
            }
            @keyframes spin { to { transform: rotate(360deg); } }
          `}</style>
          {artifacts.map((artifact) => (
            <DocumentCard key={artifact.id} artifact={artifact} />
          ))}
          {/* If still fetching, show fetcher status indicators */}
          {isRunning &&
            Object.entries(fetcherStatuses)
              .filter(([, status]) => status === 'running')
              .slice(0, Math.max(0, 6 - artifacts.length))
              .map(([fetcherId]) => (
                <div
                  key={fetcherId}
                  style={{
                    backgroundColor: 'var(--color-surface)',
                    border: '1px solid var(--color-rule)',
                    borderRadius: 'var(--radius-default)',
                    padding: '14px 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    opacity: 0.5,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: '14px',
                      height: '14px',
                      border: '2px solid var(--color-rule)',
                      borderTopColor: 'var(--color-muted)',
                      borderRadius: '50%',
                      animation: 'spin 0.7s linear infinite',
                      flexShrink: 0,
                    }}
                  />
                  <span
                    style={{
                      fontSize: 'var(--font-size-body)',
                      color: 'var(--color-faint)',
                    }}
                  >
                    {fetcherId}…
                  </span>
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
