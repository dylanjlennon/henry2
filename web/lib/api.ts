import type { WebRunStatus, HistoryItem } from '@/types/property';

// All API calls use relative URLs — Next.js rewrites proxy them to the Henry backend.
// See next.config.ts for the rewrite rule.
export async function startSearch(address: string): Promise<{ runId: string }> {
  const res = await fetch('/api/web/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  if (!res.ok) throw new Error(`Search failed: ${res.status}`);
  return res.json() as Promise<{ runId: string }>;
}

export async function getRunStatus(runId: string): Promise<WebRunStatus> {
  const res = await fetch(`/api/web/status/${runId}`);
  if (!res.ok) throw new Error(`Status fetch failed: ${res.status}`);
  return res.json() as Promise<WebRunStatus>;
}

export async function getHistory(): Promise<HistoryItem[]> {
  const res = await fetch('/api/web/history');
  if (!res.ok) throw new Error(`History fetch failed: ${res.status}`);
  const data = (await res.json()) as { runs: HistoryItem[] };
  return data.runs;
}
