'use client';

import { useQuery } from '@tanstack/react-query';
import { getRunStatus, getHistory } from '@/lib/api';
import type { WebRunStatus, HistoryItem } from '@/types/property';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'partial']);

export function useRunSearch(runId: string | null): {
  data: WebRunStatus | undefined;
  isLoading: boolean;
  isComplete: boolean;
} {
  const { data, isLoading } = useQuery<WebRunStatus>({
    queryKey: ['run', runId],
    queryFn: () => getRunStatus(runId!),
    enabled: runId !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status && TERMINAL_STATUSES.has(status)) return false;
      return 1500;
    },
    staleTime: 0,
  });

  const isComplete = data ? TERMINAL_STATUSES.has(data.status) : false;

  return { data, isLoading, isComplete };
}

export function useHistory(): {
  data: HistoryItem[] | undefined;
  isLoading: boolean;
} {
  const { data, isLoading } = useQuery<HistoryItem[]>({
    queryKey: ['history'],
    queryFn: getHistory,
    staleTime: 30_000,
  });

  return { data, isLoading };
}
