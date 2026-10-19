import { useEffect, useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { listRuns } from '@/lib/reviewApi';
import { DEFAULT_FILTERS, filterViews, findingViews, type ViewFilters } from '@/lib/findingView';
import type { AnalysisRun } from '@/lib/types';
import { useRunDetail } from '@/hooks/useRunDetail';
import { RunSidebar } from '@/components/RunSidebar';
import { RunOverview } from '@/components/RunOverview';
import { FindingCard } from '@/components/FindingCard';
import { FindingDrawer } from '@/components/FindingDrawer';
import { FindingFilters } from '@/components/FindingFilters';
import { ErrorNote, Spinner } from '@/components/ui';

export function ReviewWorkspace({ focusCompanyId }: { focusCompanyId: string | null }) {
  const [runs, setRuns] = useState<AnalysisRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filters, setFilters] = useState<ViewFilters>(DEFAULT_FILTERS);

  useEffect(() => {
    listRuns()
      .then((r) => {
        setRuns(r);
        const first = r.find((x) => x.company_id === focusCompanyId) ?? r[0];
        if (first) {
          setCompanyId(first.company_id);
          setRunId(first.id);
        }
      })
      .catch((e: Error) => setError(e.message));
  }, [focusCompanyId]);

  const run = useMemo(() => runs?.find((r) => r.id === runId) ?? null, [runs, runId]);
  const { state, addReview, addOverride, addReadiness } = useRunDetail(run);
  const views = state.status === 'ready' ? findingViews(state.detail) : [];
  const shown = filterViews(views, filters);
  const open = views.find((v) => v.finding.id === openId) ?? null;

  const selectCompany = (id: string) => {
    setCompanyId(id);
    setRunId(runs?.find((r) => r.company_id === id)?.id ?? null);
    setOpenId(null);
  };

  return (
    <>
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
                    <h2 className="label">
                      Findings ({shown.length === views.length ? views.length : `${shown.length} of ${views.length}`})
                    </h2>
                    {views.length === 0 && <p className="text-sm text-ink-500">This run produced no findings.</p>}
                    {views.length > 1 && <FindingFilters value={filters} onChange={setFilters} />}
                    {views.length > 0 && shown.length === 0 && <p className="text-sm text-ink-500">No findings match these filters.</p>}
                    <div className="grid gap-4 xl:grid-cols-2">
                      {shown.map((v, i) => <FindingCard key={v.finding.id} view={v} index={i} onOpen={() => setOpenId(v.finding.id)} />)}
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>
        )}
      </main>

      {open && state.status === 'ready' && (
        <FindingDrawer view={open} detail={state.detail} urls={state.urls} onClose={() => setOpenId(null)} onOpenFinding={setOpenId} onReviewSaved={addReview}
          onOverrideSaved={addOverride}
          onReadinessSaved={addReadiness}
        />
      )}
    </>
  );
}
