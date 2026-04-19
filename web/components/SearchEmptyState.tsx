'use client';

import React, { useCallback, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';
import { startSearch } from '@/lib/api';
import { useHistory } from '@/hooks/useSearch';

const EXAMPLES = [
  { address: '1 Battery Park Ave, Asheville', note: 'Historic district' },
  { address: '100 Beaverdam Rd, Asheville', note: 'Steep slope' },
  { address: '50 Happy Valley Rd, Weaverville', note: 'Unincorporated' },
  { address: '22 Kenilwood Pl, Asheville', note: 'RS-8 zoning' },
  { address: '351 Windsor Rd, Asheville', note: 'Elevated terrain' },
];

function useNavigateToSearch() {
  const router = useRouter();
  return useCallback(async (address: string) => {
    try {
      const { runId } = await startSearch(address);
      router.push(`/property/${runId}`);
    } catch (err) {
      console.error('Search failed', err);
    }
  }, [router]);
}

function HistoryCard({ address, status, startedAt, runId }: {
  address: string; status: string; startedAt: string; runId: string;
}) {
  const router = useRouter();
  const timeAgo = getTimeAgo(startedAt);
  const dotColor = status === 'completed' ? 'var(--color-calm)' : status === 'failed' ? 'var(--color-risk)' : 'var(--color-warn)';

  return (
    <button
      onClick={() => router.push(`/property/${runId}`)}
      style={{
        display: 'block',
        width: '100%',
        padding: '14px 16px',
        background: 'var(--color-surface)',
        border: '1px solid var(--color-rule)',
        borderRadius: 'var(--radius-lg)',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'border-color 150ms',
      }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--color-rule-strong)')}
      onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--color-rule)')}
    >
      <div style={{ fontSize: 'var(--font-size-emphasis)', fontWeight: 500, color: 'var(--color-ink)', marginBottom: '4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {address}
      </div>
      <div style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-faint)', fontFamily: 'monospace', marginBottom: '10px' }}>
        {runId.slice(0, 12)}…
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 'var(--font-size-label)', color: 'var(--color-muted)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
          <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
          {status}
        </span>
        <span>{timeAgo}</span>
      </div>
    </button>
  );
}

function ExampleRow({ address, note }: { address: string; note: string }) {
  const navigate = useNavigateToSearch();
  return (
    <button
      onClick={() => void navigate(address)}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '9px 0',
        background: 'none',
        border: 'none',
        borderBottom: '1px solid var(--color-rule)',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'var(--color-ink)',
        fontSize: 'var(--font-size-body)',
      }}
      onMouseEnter={e => (e.currentTarget.style.color = 'var(--color-info)')}
      onMouseLeave={e => (e.currentTarget.style.color = 'var(--color-ink)')}
    >
      <span>{address}</span>
      <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-faint)', marginLeft: '12px', whiteSpace: 'nowrap' }}>
        {note}
      </span>
    </button>
  );
}

function HeroSearch() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const handleSubmit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isSearching) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const { runId } = await startSearch(trimmed);
      router.push(`/property/${runId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Search failed. Please try again.';
      setSearchError(msg);
      setIsSearching(false);
    }
  }, [value, isSearching, router]);

  return (
    <>
    <div style={{
      display: 'flex',
      gap: '8px',
      maxWidth: '560px',
      margin: '0 auto',
    }}>
      <div style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        background: 'var(--color-surface)',
        border: '1.5px solid var(--color-rule)',
        borderRadius: 'var(--radius-lg)',
        padding: '0 16px',
        height: '48px',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
      }}
        onFocus={e => ((e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-rule-strong)')}
        onBlur={e => ((e.currentTarget as HTMLDivElement).style.borderColor = 'var(--color-rule)')}
      >
        <Search size={16} color="var(--color-faint)" style={{ flexShrink: 0 }} />
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && void handleSubmit()}
          placeholder="190 Robinhood Rd, Asheville, NC…"
          autoFocus
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: '15px',
            color: 'var(--color-ink)',
          }}
        />
      </div>
      <button
        onClick={() => void handleSubmit()}
        disabled={!value.trim() || isSearching}
        style={{
          height: '48px',
          padding: '0 22px',
          background: 'var(--color-info)',
          color: '#fff',
          border: 'none',
          borderRadius: 'var(--radius-lg)',
          fontSize: 'var(--font-size-body)',
          fontWeight: 500,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          opacity: !value.trim() || isSearching ? 0.55 : 1,
          transition: 'opacity 150ms',
        }}
      >
        {isSearching ? 'Searching…' : 'Search'}
      </button>
    </div>
    {searchError && (
      <p style={{
        color: 'var(--color-risk)',
        fontSize: '13px',
        textAlign: 'center',
        maxWidth: '560px',
        margin: '10px auto 0',
        lineHeight: '1.5',
      }}>
        {searchError}
      </p>
    )}
    </>
  );
}

export default function SearchEmptyState() {
  const { data: history } = useHistory();
  const recentSearches = (history ?? []).slice(0, 6);

  return (
    <div style={{ maxWidth: '900px', margin: '0 auto', padding: '0 24px 80px' }}>
      {/* Hero */}
      <div style={{ textAlign: 'center', padding: '72px 0 48px' }}>
        <h1 style={{
          fontSize: '32px',
          fontWeight: 500,
          letterSpacing: '-0.5px',
          lineHeight: '1.2',
          margin: '0 0 12px',
          color: 'var(--color-ink)',
        }}>
          Property research,{' '}
          <span style={{ color: 'var(--color-info)' }}>done in minutes.</span>
        </h1>
        <p style={{
          color: 'var(--color-muted)',
          fontSize: 'var(--font-size-body)',
          maxWidth: '400px',
          margin: '0 auto 32px',
          lineHeight: '22px',
        }}>
          Type any Buncombe County address or PIN. Henry pulls every public record and delivers a complete property intelligence report.
        </p>
        <HeroSearch />
      </div>

      {/* Recent searches grid */}
      {recentSearches.length > 0 && (
        <section style={{ marginBottom: '48px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
            <span style={{
              fontSize: 'var(--font-size-label)',
              fontWeight: 500,
              color: 'var(--color-faint)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
            }}>
              Recent
            </span>
          </div>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: '10px',
          }}>
            {recentSearches.map((item) => (
              <HistoryCard
                key={item.runId}
                address={item.address}
                status={item.status}
                startedAt={item.startedAt}
                runId={item.runId}
              />
            ))}
          </div>
        </section>
      )}

      {/* Example addresses */}
      <section style={{ maxWidth: '480px', margin: '0 auto' }}>
        <div style={{
          fontSize: 'var(--font-size-label)',
          fontWeight: 500,
          color: 'var(--color-faint)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: '4px',
        }}>
          Try
        </div>
        {EXAMPLES.map((ex) => (
          <ExampleRow key={ex.address} address={ex.address} note={ex.note} />
        ))}
      </section>

      {/* Data sources footer */}
      <div style={{
        textAlign: 'center',
        marginTop: '64px',
        fontSize: 'var(--font-size-label)',
        color: 'var(--color-faint)',
        lineHeight: '20px',
      }}>
        Buncombe County GIS · FEMA NFHL · NCGS Landslide · USGS 3DEP · USDA SSURGO · Asheville Planning
      </div>
    </div>
  );
}

function getTimeAgo(isoString: string): string {
  try {
    const diff = Date.now() - new Date(isoString).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return '';
  }
}
