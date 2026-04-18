'use client';

import React, { useCallback } from 'react';
import Pill from '@/components/Pill';
import type {
  WebRunStatus,
  ParcelData,
  JurisdictionData,
  HistoricDistrictData,
  STREligibilityData,
} from '@/types/property';

interface PropertyHeroProps {
  runStatus: WebRunStatus;
}

function SkeletonBar({ width }: { width: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width,
        height: '12px',
        backgroundColor: 'var(--color-sunken)',
        borderRadius: '3px',
      }}
    />
  );
}

function CopyableText({ text, label }: { text: string; label: string }) {
  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(text);
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      title={`Copy ${label}`}
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        color: 'inherit',
        font: 'inherit',
        textAlign: 'left',
        textDecoration: 'underline',
        textDecorationStyle: 'dotted',
        textDecorationColor: 'var(--color-rule-strong)',
      }}
    >
      {text}
    </button>
  );
}

function formatCurrency(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

function formatNumber(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('en-US').format(value);
}

export default function PropertyHero({ runStatus }: PropertyHeroProps) {
  const parcel = runStatus.fetcherData['parcel-json'] as unknown as ParcelData | undefined;
  const jurisdiction = runStatus.fetcherData['jurisdiction'] as unknown as JurisdictionData | undefined;
  const historic = runStatus.fetcherData['historic-district'] as unknown as HistoricDistrictData | undefined;
  const str = runStatus.fetcherData['str-eligibility'] as unknown as STREligibilityData | undefined;

  const isLoading = !parcel;

  return (
    <div
      style={{
        backgroundColor: 'var(--color-surface)',
        borderBottom: '1px solid var(--color-rule)',
        padding: '24px 16px',
      }}
    >
      <div style={{ maxWidth: '720px', margin: '0 auto' }}>
        {/* Address */}
        <div style={{ marginBottom: '4px' }}>
          {isLoading ? (
            <SkeletonBar width="60%" />
          ) : parcel?.address ? (
            <h1
              style={{
                fontSize: 'var(--font-size-heading)',
                fontWeight: 500,
                margin: 0,
                lineHeight: '28px',
              }}
            >
              <CopyableText text={parcel.address} label="address" />
            </h1>
          ) : (
            <h1
              style={{
                fontSize: 'var(--font-size-heading)',
                fontWeight: 500,
                margin: 0,
                lineHeight: '28px',
                color: 'var(--color-muted)',
              }}
            >
              {runStatus.address}
            </h1>
          )}
        </div>

        {/* PIN + owner */}
        <div
          style={{
            fontSize: 'var(--font-size-body)',
            color: 'var(--color-muted)',
            marginBottom: '16px',
          }}
        >
          {isLoading ? (
            <SkeletonBar width="40%" />
          ) : (
            <>
              {parcel?.pin && (
                <>
                  PIN: <CopyableText text={parcel.pin} label="PIN" />
                  {parcel?.owner && ' · '}
                </>
              )}
              {parcel?.owner && <span>{parcel.owner}</span>}
            </>
          )}
        </div>

        {/* Stats row */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '16px',
            fontSize: 'var(--font-size-label)',
            color: 'var(--color-muted)',
            marginBottom: '16px',
          }}
        >
          {isLoading ? (
            <>
              <SkeletonBar width="80px" />
              <SkeletonBar width="80px" />
              <SkeletonBar width="80px" />
              <SkeletonBar width="80px" />
            </>
          ) : (
            <>
              {parcel?.acreage != null && (
                <span>
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {parcel.acreage.toFixed(2)}
                  </span>{' '}
                  ac
                </span>
              )}
              {parcel?.sqFt != null && (
                <span>
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {formatNumber(parcel.sqFt)}
                  </span>{' '}
                  sq ft
                </span>
              )}
              {parcel?.yearBuilt != null && (
                <span>
                  Built{' '}
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {parcel.yearBuilt}
                  </span>
                </span>
              )}
              {parcel?.taxValue != null && (
                <span>
                  Tax value{' '}
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {formatCurrency(parcel.taxValue)}
                  </span>
                </span>
              )}
              {parcel?.municipality && (
                <span>
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {parcel.municipality}
                  </span>
                </span>
              )}
            </>
          )}
        </div>

        {/* Pills */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {jurisdiction && (
            <Pill tone="info">
              {jurisdiction.jurisdiction}
            </Pill>
          )}
          {historic?.inLocalHistoricDistrict && (
            <Pill tone="warn">
              Historic: {historic.districtName ?? 'Local District'}
            </Pill>
          )}
          {str && str.eligible !== null && (
            <Pill tone={str.eligible ? 'calm' : 'risk'}>
              STR: {str.eligible ? 'Eligible' : 'Not eligible'}
            </Pill>
          )}
        </div>
      </div>
    </div>
  );
}
