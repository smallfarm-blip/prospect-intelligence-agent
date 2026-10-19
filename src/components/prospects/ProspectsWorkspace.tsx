import { useMemo, useState } from 'react';
import { useProspectBoard } from '@/hooks/useProspectBoard';
import { buildViews } from '@/lib/prospectView';
import { ErrorNote, Spinner } from '@/components/ui';
import { ProspectDashboard } from '@/components/prospects/ProspectDashboard';
import { ProspectDetailPage } from '@/components/prospects/ProspectDetailPage';
import { ImportDialog } from '@/components/prospects/ImportDialog';

export function ProspectsWorkspace({ onOpenResearch }: { onOpenResearch: (companyId: string) => void }) {
  const { state, reload } = useProspectBoard();
  const [openId, setOpenId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const views = useMemo(() => (state.status === 'ready' ? buildViews(state.board) : []), [state]);
  const open = views.find((v) => v.id === openId) ?? null;

  return (
    <main className="mx-auto max-w-7xl px-6 py-8">
      {state.status === 'loading' && <Spinner label="Loading prospects..." />}
      {state.status === 'error' && <ErrorNote message={state.message} />}
      {state.status === 'ready' && open && (
        <ProspectDetailPage
          view={open}
          board={state.board}
          onBack={() => setOpenId(null)}
          onChanged={reload}
          onOpenResearch={onOpenResearch}
        />
      )}
      {state.status === 'ready' && !open && (
        <ProspectDashboard views={views} board={state.board} onOpen={(id) => { setOpenId(id); window.scrollTo({ top: 0 }); }} onAdd={() => setImporting(true)} />
      )}
      {importing && (
        <ImportDialog
          onClose={() => setImporting(false)}
          onImported={() => void reload()}
          onOpen={(id) => { setImporting(false); setOpenId(id); }}
        />
      )}
    </main>
  );
}
