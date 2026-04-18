'use client';

import React from 'react';
import { use } from 'react';
import SearchBar from '@/components/SearchBar';
import PropertyHero from '@/components/PropertyHero';
import KeyFindings from '@/components/KeyFindings';
import DocumentsPanel from '@/components/DocumentsPanel';
import ContextGrid from '@/components/ContextGrid';
import ActionRow from '@/components/ActionRow';
import { useRunSearch } from '@/hooks/useSearch';

interface PropertyPageProps {
  params: Promise<{ runId: string }>;
}

function ProgressBar({ completed, total }: { completed: number; total: number }) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  return (
    <div
      style={{
        maxWidth: '720px',
        margin: '0 auto',
        padding: '12px 16px 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          fontSize: 'var(--font-size-label)',
          color: 'var(--color-muted)',
          marginBottom: '6px',
        }}
      >
        <span
          style={{
            width: '12px',
            height: '12px',
            border: '1.5px solid var(--color-rule)',
            borderTopColor: 'var(--color-ink)',
            borderRadius: '50%',
            display: 'inline-block',
            animation: 'spin 0.7s linear infinite',
            flexShrink: 0,
          }}
        />
        <span>
          Fetching data · {completed}/{total} complete
        </span>
        <span style={{ marginLeft: 'auto', color: 'var(--color-faint)' }}>{pct}%</span>
      </div>
      <div
        style={{
          height: '4px',
          backgroundColor: 'var(--color-sunken)',
          borderRadius: '2px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${pct}%`,
            backgroundColor: 'var(--color-calm)',
            borderRadius: '2px',
            transition: 'width 400ms ease',
          }}
        />
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export default function PropertyPage({ params }: PropertyPageProps) {
  const { runId } = use(params);
  const { data: runStatus } = useRunSearch(runId);

  const isRunning = !runStatus || runStatus.status === 'running';
  const address = runStatus?.address ?? '';

  return (
    <>
      <SearchBar defaultValue={address} />

      {!runStatus ? (
        // First-load skeleton — show structure immediately
        <div style={{ padding: '48px 16px', textAlign: 'center', color: 'var(--color-faint)' }}>
          Loading…
        </div>
      ) : (
        <>
          {isRunning && (
            <ProgressBar
              completed={runStatus.fetchersCompleted}
              total={runStatus.fetchersPlanned}
            />
          )}

          <PropertyHero runStatus={runStatus} />

          <KeyFindings fetcherData={runStatus.fetcherData} />

          <DocumentsPanel
            artifacts={runStatus.artifacts}
            runStatus={runStatus.status}
            fetcherStatuses={runStatus.fetcherStatuses}
          />

          <ContextGrid
            fetcherData={runStatus.fetcherData}
            runStatus={runStatus.status}
          />

          {!isRunning && (
            <ActionRow artifacts={runStatus.artifacts} />
          )}
        </>
      )}
    </>
  );
}
