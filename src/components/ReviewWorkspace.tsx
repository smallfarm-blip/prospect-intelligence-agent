import { useEffect, useMemo, useState } from 'react';
import { Inbox, LogOut, ScanSearch } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { listRuns } from '@/lib/reviewApi';
import { findingViews } from '@/lib/findingView';
import type { AnalysisRun } from '@/lib/types';
import { useRunDetail } from '@/hooks/useRunDetail';
import { RunSidebar } from '@/components/RunSidebar';
import { RunOverview } from '@/components/RunOverview';
import { FindingCard } from '@/components/FindingCard';
import { FindingDrawer } from '@/components/FindingDrawer';
import { ErrorNote, Spinner } from '@/components/ui';

export function ReviewWorkspace({ session }: { session: Session }) {
  const [runs, setRuns] = useState<AnalysisRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    listRuns()
      .then((r) => {
        setRuns(r);
        if (r[0]) {
          setCompanyId(r[0].company_id);
          setRunId(r[0].id);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const run = useMemo(() => runs?.find((r) => r.id === runId) ?? null, [runs, runId]);
  const { state, addReview } = useRunDetail(run);
  const views = state.status === 'ready' ? findingViews(state.detail) : [];
  const open = views.find((v) => v.finding.id === openId) ?? null;

  const selectCompany = (id: string) => {
    setCompanyId(id);
    setRunId(runs?.find((r) => r.company_id === id)?.id ?? null);
    setOpenId(null);
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-ink-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-ink-900">
            <ScanSearch className="h-5 w-5 text-primary-600" /> Finding review
          </div>
          <div className="flex items-center gap-3 text-sm text-ink-500">
            <span className="hidden sm:inline">{session.user.email}</span>
            <button className="btn-ghost px-2 py-1" onClick={() => supabase.auth.signOut()}>
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {error && <ErrorNote message={error} />}
        {!error && !runs && <Spinner label="Loading analysis runs..." />}
        {runs && runs.length === 0 && (
          <div className="card mx-auto max-w-lg p-10 text-center">
            <Inbox className="mx-auto h-8 w-8 text-ink-300" />
            <h2 className="mt-4 font-serif text-xl font-semibold text-ink-900">No analysis runs yet</h2>
            <p className="mt-2 text-sm text-ink-500">Findings appear here once the analysis worker has completed a run.</p>
          </div>
        )}
        {runs && runs.length > 0 && (
          <div className="grid gap-8 lg:grid-cols-[260px_1fr]">
            <RunSidebar runs={runs} companyId={companyId} runId={runId} onCompany={selectCompany} onRun={(id) => { setRunId(id); setOpenId(null); }} />
            <div className="min-w-0 space-y-8">
              {state.status === 'loading' && <Spinner label="Loading findings and screenshots..." />}
              {state.status === 'error' && <ErrorNote message={state.message} />}
              {state.status === 'ready' && (
                <>
                  <RunOverview detail={state.detail} />
                  <section className="space-y-3">
                    <h2 className="label">Findings ({views.length})</h2>
                    {views.length === 0 && <p className="text-sm text-ink-500">This run produced no findings.</p>}
                    <div className="grid gap-4 xl:grid-cols-2">
                      {views.map((v, i) => <FindingCard key={v.finding.id} view={v} index={i} onOpen={() => setOpenId(v.finding.id)} />)}
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {open && state.status === 'ready' && (
        <FindingDrawer view={open} detail={state.detail} urls={state.urls} onClose={() => setOpenId(null)} onOpenFinding={setOpenId} onReviewSaved={addReview} />
      )}
    </div>
  );
}
