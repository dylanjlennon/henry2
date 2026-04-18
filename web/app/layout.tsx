import type { Metadata } from 'next';
import './globals.css';
import Providers from './Providers';

export const metadata: Metadata = {
  title: 'Henry — Buncombe County Property Research',
  description: 'Research any Buncombe County property: flood, slope, historic, STR eligibility, and more.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <header style={{
            background: 'var(--color-surface)',
            borderBottom: '1px solid var(--color-rule)',
            padding: '0 24px',
            height: '52px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            position: 'sticky',
            top: 0,
            zIndex: 100,
          }}>
            <a href="/" style={{ display: 'flex', alignItems: 'baseline', gap: '2px', textDecoration: 'none' }}>
              <span style={{ fontWeight: 500, fontSize: '18px', letterSpacing: '-0.4px', color: 'var(--color-ink)' }}>Henry</span>
              <span style={{ fontWeight: 500, fontSize: '18px', color: 'var(--color-info)' }}>.</span>
            </a>
            <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-faint)', fontWeight: 500 }}>
              Buncombe County, NC
            </span>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
