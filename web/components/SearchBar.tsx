'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, X } from 'lucide-react';
import { startSearch } from '@/lib/api';

interface SearchBarProps {
  defaultValue?: string;
}

export default function SearchBar({ defaultValue = '' }: SearchBarProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(defaultValue);
  const [isSearching, setIsSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedValue, setDebouncedValue] = useState(defaultValue);

  // Debounce the input
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setValue(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedValue(v), 300);
  }, []);

  // Keep debouncedValue in sync (avoid lint warning)
  useEffect(() => {
    void debouncedValue;
  }, [debouncedValue]);

  const handleSubmit = useCallback(
    async (address: string) => {
      const trimmed = address.trim();
      if (!trimmed || isSearching) return;
      setIsSearching(true);
      try {
        const { runId } = await startSearch(trimmed);
        router.push(`/property/${runId}`);
      } catch (err) {
        console.error('Search failed', err);
        setIsSearching(false);
      }
    },
    [isSearching, router]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        void handleSubmit(value);
      }
    },
    [handleSubmit, value]
  );

  const handleClear = useCallback(() => {
    setValue('');
    setDebouncedValue('');
    inputRef.current?.focus();
  }, []);

  // Global keyboard shortcut: / or Cmd+K
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.key === '/' && document.activeElement?.tagName !== 'INPUT') ||
        (e.key === 'k' && (e.metaKey || e.ctrlKey))
      ) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Google Places autocomplete
  useEffect(() => {
    const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PLACES_API_KEY;
    if (!apiKey || !inputRef.current || typeof window === 'undefined') return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = (window as any).google;
    if (!g?.maps?.places) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ac = new g.maps.places.Autocomplete(inputRef.current, {
      types: ['address'],
      componentRestrictions: { country: 'us' },
    }) as { addListener: (ev: string, cb: () => void) => void; getPlace: () => { formatted_address?: string } };

    ac.addListener('place_changed', () => {
      const place = ac.getPlace();
      if (place.formatted_address) {
        setValue(place.formatted_address);
        void handleSubmit(place.formatted_address);
      }
    });
  }, [handleSubmit]);

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        backgroundColor: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-rule)',
        transition: 'border-color 150ms',
      }}
    >
      <div
        style={{
          maxWidth: '720px',
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          height: '44px',
          padding: '0 16px',
          gap: '8px',
        }}
      >
        <div style={{ color: 'var(--color-faint)', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
          {isSearching ? (
            <span
              style={{
                width: '16px',
                height: '16px',
                border: '2px solid var(--color-rule)',
                borderTopColor: 'var(--color-ink)',
                borderRadius: '50%',
                display: 'inline-block',
                animation: 'spin 0.7s linear infinite',
              }}
            />
          ) : (
            <Search size={16} />
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder="Search a property address or PIN…"
          autoComplete="off"
          style={{
            flex: 1,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 'var(--font-size-body)',
            color: 'var(--color-ink)',
            lineHeight: '20px',
          }}
        />
        {value && (
          <button
            onClick={handleClear}
            style={{
              display: 'flex',
              alignItems: 'center',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: 'var(--color-faint)',
              padding: '4px',
              flexShrink: 0,
            }}
            aria-label="Clear search"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 767px) {
          .searchbar-inner { height: 52px !important; }
        }
      `}</style>
    </div>
  );
}
