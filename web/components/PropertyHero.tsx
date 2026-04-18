'use client';

import React, { useCallback } from 'react';
import Pill from '@/components/Pill';
import type {
  WebRunStatus,
  ParcelJsonData,
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

function formatCurrencyFromString(value: string | undefined | null): string {
  if (!value) return '—';
  const num = parseFloat(value);
  if (isNaN(num)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(num);
}

function titleCase(str: string): string {
  return str
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (c) => c.toUpperCase());
}

function formatOwner(owner: string | undefined): string {
  if (!owner) return '';
  return titleCase(owner.replace(/;/g, ' & '));
}

export default function PropertyHero({ runStatus }: PropertyHeroProps) {
  const parcelJson = runStatus.fetcherData['parcel-json'] as unknown as ParcelJsonData | undefined;
  const attrs = parcelJson?.attributes;
  const jurisdiction = runStatus.fetcherData['jurisdiction'] as unknown as JurisdictionData | undefined;
  const historic = runStatus.fetcherData['historic-district'] as unknown as HistoricDistrictData | undefined;
  const str = runStatus.fetcherData['str-eligibility'] as unknown as STREligibilityData | undefined;

  const isLoading = !attrs;

  const addressLine = attrs
    ? `${attrs.Address}, ${attrs.CityName} NC ${attrs.Zipcode}`
    : runStatus.address;

  const ownerDisplay = formatOwner(attrs?.Owner);
  const pin = runStatus.pin ?? attrs?.PIN ?? null;
  const acreage = attrs?.Acreage;
  const taxValue = attrs?.TaxValue;
  const subName = attrs?.SubName;
  const deedRef = attrs ? `Book ${attrs.DeedBook} / Page ${attrs.DeedPage}` : null;

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
          ) : (
            <h1
              style={{
                fontSize: 'var(--font-size-heading)',
                fontWeight: 500,
                margin: 0,
                lineHeight: '28px',
              }}
            >
              <CopyableText text={addressLine} label="address" />
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
              {pin && (
                <>
                  PIN: <CopyableText text={pin} label="PIN" />
                  {ownerDisplay && ' · '}
                </>
              )}
              {ownerDisplay && <span>{ownerDisplay}</span>}
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
              {ownerDisplay && (
                <span>
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {ownerDisplay}
                  </span>
                </span>
              )}
              {acreage != null && (
                <span>
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {acreage.toFixed(2)}
                  </span>{' '}
                  ac
                </span>
              )}
              {taxValue && (
                <span>
                  Tax value{' '}
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {formatCurrencyFromString(taxValue)}
                  </span>
                </span>
              )}
              {deedRef && (
                <span>
                  Deed{' '}
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {deedRef}
                  </span>
                </span>
              )}
              {subName && (
                <span>
                  <span style={{ color: 'var(--color-ink)', fontWeight: 500 }}>
                    {titleCase(subName)}
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
