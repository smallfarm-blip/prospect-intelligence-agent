import { useCallback, useEffect, useState } from 'react';
import { loadBoard } from '@/lib/prospectApi';
import type { ProspectBoard } from '@/lib/prospectTypes';

type BoardState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; board: ProspectBoard };

export function useProspectBoard() {
  const [state, setState] = useState<BoardState>({ status: 'loading' });

  const reload = useCallback(async () => {
    try {
      setState({ status: 'ready', board: await loadBoard() });
    } catch (e) {
      setState({ status: 'error', message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, reload };
}
