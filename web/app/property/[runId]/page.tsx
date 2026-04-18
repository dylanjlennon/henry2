'use client';

import React from 'react';
import { use } from 'react';
import SearchBar from '@/components/SearchBar';
import PropertyHero from '@/components/PropertyHero';
import ContextGrid from '@/components/ContextGrid';
import ActionRow from '@/components/ActionRow';
import { useRunSearch } from '@/hooks/useSearch';

interface PropertyPageProps {
  params: Promise<{ runId: string }>;
}

export default function PropertyPage({ params }: PropertyPageProps) {
  const { runId } = use(params);
  const { data: runStatus, isLoading } = useRunSearch(runId);

  const isRunning = !runStatus || runStatus.status === 'running';
  const address = runStatus?.address ?? '';

  // Empty fetcherData for skeleton tiles
  const emptyFetcherData: Record<string, Record<string, unknown>> = {};

  return (
    <>
      <SearchBar defaultValue={address} />

      {isLoading && !runStatus ? (
        <div style={{ padding: '48px 16px', textAlign: 'center', color: 'var(--color-faint)' }}>
          Loading…
        </div>
      ) : (
        <>
          {runStatus && (
            <PropertyHero runStatus={runStatus} />
          )}

          {isRunning ? (
            <>
              {/* Show progress while running */}
              {runStatus && (
                <div
                  style={{
                    maxWidth: '720px',
                    margin: '16px auto 0',
                    padding: '0 16px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                >
                  <span
                    style={{
                      width: '14px',
                      height: '14px',
                      border: '2px solid var(--color-rule)',
                      borderTopColor: 'var(--color-ink)',
                      borderRadius: '50%',
                      display: 'inline-block',
                      animation: 'spin 0.7s linear infinite',
                      flexShrink: 0,
                    }}
                  />
                  <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-muted)' }}>
                    Fetching data… {runStatus.fetchersCompleted}/{runStatus.fetchersPlanned} complete
                  </span>
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
                </div>
              )}
              {/* Skeleton grid while loading */}
              <ContextGrid
                fetcherData={emptyFetcherData}
                runStatus="running"
              />
            </>
          ) : (
            runStatus && (
              <>
                <ContextGrid
                  fetcherData={runStatus.fetcherData}
                  runStatus={runStatus.status}
                />
                <ActionRow />
              </>
            )
          )}
        </>
      )}
    </>
  );
}
