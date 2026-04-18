'use client';

import React, { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { startSearch } from '@/lib/api';
import { useHistory } from '@/hooks/useSearch';

const EXAMPLE_ADDRESSES = [
  '1 Battery Park Ave, Asheville',
  '100 Beaverdam Rd, Asheville',
  '50 Happy Valley Rd, Weaverville',
];

interface AddressRowProps {
  address: string;
  meta?: string;
}

function AddressRow({ address, meta }: AddressRowProps) {
  const router = useRouter();

  const handleClick = useCallback(async () => {
    try {
      const { runId } = await startSearch(address);
      router.push(`/property/${runId}`);
    } catch (err) {
      console.error('Search failed', err);
    }
  }, [address, router]);

  return (
    <button
      onClick={() => void handleClick()}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        padding: '10px 0',
        background: 'none',
        border: 'none',
        borderBottom: '1px solid var(--color-rule)',
        cursor: 'pointer',
        textAlign: 'left',
        color: 'var(--color-ink)',
        fontSize: 'var(--font-size-body)',
      }}
    >
      <span>{address}</span>
      {meta && (
        <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-faint)', marginLeft: '12px', whiteSpace: 'nowrap' }}>
          {meta}
        </span>
      )}
    </button>
  );
}

export default function SearchEmptyState() {
  const { data: history } = useHistory();
  const recentSearches = (history ?? []).slice(0, 5);

  return (
    <div
      style={{
        maxWidth: '480px',
        margin: '96px auto 0',
        padding: '0 16px',
      }}
    >
      <h2
        style={{
          fontSize: 'var(--font-size-heading)',
          fontWeight: 500,
          margin: '0 0 32px',
          color: 'var(--color-ink)',
        }}
      >
        Search a property address
      </h2>

      {recentSearches.length > 0 && (
        <section style={{ marginBottom: '32px' }}>
          <div
            style={{
              fontSize: 'var(--font-size-label)',
              fontWeight: 500,
              color: 'var(--color-faint)',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              marginBottom: '4px',
            }}
          >
            Recent
          </div>
          {recentSearches.map((item) => (
            <AddressRow
              key={item.runId}
              address={item.address}
              meta={item.status}
            />
          ))}
        </section>
      )}

      <section>
        <div
          style={{
            fontSize: 'var(--font-size-label)',
            fontWeight: 500,
            color: 'var(--color-faint)',
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            marginBottom: '4px',
          }}
        >
          Try
        </div>
        {EXAMPLE_ADDRESSES.map((addr) => (
          <AddressRow key={addr} address={addr} />
        ))}
      </section>
    </div>
  );
}
