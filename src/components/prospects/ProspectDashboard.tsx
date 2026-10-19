import { useMemo, useState } from 'react';
import { Building2, CircleDollarSign, FlaskConical, Gauge, Plus } from 'lucide-react';
import type { ProspectBoard } from '@/lib/prospectTypes';
import { DEFAULT_PROSPECT_FILTERS, filterViews, QUEUES, queueCounts, topRecommendations, type ProspectFilters, type ProspectView, type Queue } from '@/lib/prospectView';
import { usd } from '@/lib/format';
import { QUEUE_META } from '@/components/prospects/labels';
import { ProspectFilterBar } from '@/components/prospects/ProspectFilterBar';
import { ProspectList } from '@/components/prospects/ProspectList';
import { TopRecommendations } from '@/components/prospects/TopRecommendations';

interface Props {
  views: ProspectView[];
  board: ProspectBoard;
  onOpen: (id: string) => void;
  onAdd: () => void;
}

export function ProspectDashboard({ views, board, onOpen, onAdd }: Props) {
  const [filters, setFilters] = useState<ProspectFilters>(DEFAULT_PROSPECT_FILTERS);
  const [queue, setQueue] = useState<Queue | 'all'>('all');
  const filtered = useMemo(() => filterViews(views, filters), [views, filters]);
  const counts = useMemo(() => queueCounts(filtered), [filtered]);
  const shown = queue === 'all' ? filtered : filtered.filter((v) => v.queue === queue);
  const recommendations = useMemo(() => topRecommendations(views), [views]);
  const scored = views.filter((v) => v.score).length;
  const approved = views.filter((v) => v.state === 'research_requested');
  const approvedCost = approved.reduce((s, v) => s + Number(v.decision?.expected_cost_usd ?? 0), 0);

  return (
    <div className="space-y-8 animate-fade-up">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-serif text-3xl font-semibold text-ink-900">Prospects</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">
            Companies being qualified for the eCommerce Growth Opportunity Sprint. Scores only count evidence that has been collected; the range shows how far each could move once unknowns are resolved.
          </p>
        </div>
        <button className="btn-primary" onClick={onAdd}>
          <Plus className="h-4 w-4" /> Add companies
        </button>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon={Building2} label="Companies" value={String(views.length)} />
        <Stat icon={Gauge} label="Scored" value={`${scored} of ${views.length}`} />
        <Stat icon={FlaskConical} label="Research approved" value={String(approved.length)} sub={approved.length ? `${usd(approvedCost, 2)} estimated, not yet run` : undefined} />
        <Stat icon={CircleDollarSign} label="Search and screening spend" value={usd(board.spentUsd, 2)} />
      </div>

      {views.length === 0 ? (
        <div className="card mx-auto max-w-lg p-10 text-center">
          <Building2 className="mx-auto h-8 w-8 text-ink-300" />
          <h2 className="mt-4 font-serif text-xl font-semibold text-ink-900">No prospects yet</h2>
          <p className="mt-2 text-sm text-ink-500">Companies appear here once discovery has run, or when you add them yourself.</p>
          <button className="btn-primary mt-6" onClick={onAdd}>
            <Plus className="h-4 w-4" /> Add companies
          </button>
        </div>
      ) : (
        <>
          <TopRecommendations items={recommendations} scored={scored} onOpen={onOpen} />

          <section className="space-y-4">
            <div className="flex flex-wrap gap-2" role="tablist" aria-label="Qualification queues">
              <QueueTab active={queue === 'all'} onClick={() => setQueue('all')} label="All" count={filtered.length} />
              {QUEUES.map((q) => (
                <QueueTab key={q} active={queue === q} onClick={() => setQueue(q)} label={QUEUE_META[q].label} count={counts[q]} hint={QUEUE_META[q].hint} />
              ))}
            </div>
            <ProspectFilterBar value={filters} onChange={setFilters} views={views} />
            <ProspectList views={shown} onOpen={onOpen} total={views.length} />
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ icon: Icon, label, value, sub }: { icon: typeof Building2; label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 text-ink-500">
        <Icon className="h-4 w-4" />
        <span className="label">{label}</span>
      </div>
      <div className="mt-2 font-serif text-2xl font-semibold text-ink-900">{value}</div>
      {sub && <div className="mt-1 text-xs text-ink-500">{sub}</div>}
    </div>
  );
}

function QueueTab({ active, onClick, label, count, hint }: { active: boolean; onClick: () => void; label: string; count: number; hint?: string }) {
  return (
    <button
      role="tab"
      aria-selected={active}
      title={hint}
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition ${
        active ? 'border-primary-700 bg-primary-700 text-white shadow-sm' : 'border-ink-200 bg-white text-ink-600 hover:border-ink-300 hover:text-ink-900'
      }`}
    >
      {label}
      <span className={`rounded-full px-1.5 text-xs ${active ? 'bg-white/20 text-white' : 'bg-ink-100 text-ink-600'}`}>{count}</span>
    </button>
  );
}
