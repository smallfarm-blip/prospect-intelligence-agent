import { ArrowRight, Gauge, History, MessageSquare, ScanSearch, UserPen } from 'lucide-react';
import type { ProspectBoard } from '@/lib/prospectTypes';
import type { ProspectView } from '@/lib/prospectView';
import { formatDate, humanize, usd } from '@/lib/format';
import { Badge } from '@/components/ui';
import { ACTION_META, FIT_LABELS, NEXT_ACTION_META, OVERRIDE_FIELD_LABELS } from '@/components/prospects/labels';

interface Entry {
  at: string;
  key: string;
  icon: typeof History;
  title: string;
  body?: string;
}

export function HistoryPanel({ view, board }: { view: ProspectView; board: ProspectBoard }) {
  const entries: Entry[] = [
    ...board.decisions.filter((d) => d.company_id === view.id).map((d) => ({
      at: d.created_at,
      key: d.id,
      icon: MessageSquare,
      title: `${ACTION_META[d.decision].label}${d.expected_cost_usd != null ? ` · estimated ${usd(d.expected_cost_usd, 2)}` : ''}`,
      body: d.reason,
    })),
    ...board.overrides.filter((o) => o.company_id === view.id).map((o) => {
      const fmt = (v: string | null) => {
        if (!v) return '-';
        if (o.field === 'fit_status') return FIT_LABELS[v as keyof typeof FIT_LABELS] ?? v;
        if (o.field === 'next_action') return NEXT_ACTION_META[v as keyof typeof NEXT_ACTION_META]?.label ?? v;
        return v;
      };
      return { at: o.created_at, key: o.id, icon: UserPen, title: `${OVERRIDE_FIELD_LABELS[o.field]} changed: ${fmt(o.previous_value)} to ${fmt(o.new_value)}`, body: o.reason };
    }),
    ...board.scores.filter((s) => s.company_id === view.id).map((s) => ({
      at: s.computed_at,
      key: s.id,
      icon: Gauge,
      title: `Scored ${s.evidence_score} (range ${s.potential_min}-${s.potential_max}), ${FIT_LABELS[s.fit_status]}${s.qualification?.nextAction ? ` · next: ${NEXT_ACTION_META[s.qualification.nextAction.key].label}` : ''}`,
      body: s.scoring_version,
    })),
    { at: view.prospect.created_at, key: 'added', icon: History, title: 'Added to prospects', body: undefined },
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <section className="card p-5">
      <h2 className="label">History</h2>
      <p className="mt-1 text-xs text-ink-400">Every decision and change is kept permanently and cannot be edited.</p>
      <ol className="mt-4 space-y-4 border-l border-ink-100 pl-4">
        {entries.map(({ key, icon: Icon, title, body, at }) => (
          <li key={key} className="relative">
            <span className="absolute -left-[25px] top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-white ring-1 ring-ink-200">
              <Icon className="h-2.5 w-2.5 text-ink-500" />
            </span>
            <div className="text-sm text-ink-800">{title}</div>
            {body && <p className="text-sm text-ink-500">{body}</p>}
            <div className="text-xs text-ink-400">{formatDate(at)}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function ExistingResearch({ view, onOpenResearch }: { view: ProspectView; onOpenResearch: (companyId: string) => void }) {
  return (
    <section className="card p-5">
      <div className="flex items-center gap-2">
        <ScanSearch className="h-4 w-4 text-ink-500" />
        <h2 className="label">Existing site research</h2>
      </div>
      {view.research.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No site captures or analyses have been run for this company.</p>
      ) : (
        <>
          <ul className="mt-3 space-y-2">
            {view.research.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-ink-700">{formatDate(r.started_at)}</span>
                <span className="flex items-center gap-1.5">
                  <Badge tone={r.status === 'completed' ? 'success' : 'neutral'}>{humanize(r.status)}</Badge>
                  <span className="text-xs text-ink-500">{r.finding_count} findings</span>
                </span>
              </li>
            ))}
          </ul>
          <button className="btn-ghost mt-3 w-full justify-between" onClick={() => onOpenResearch(view.id)}>
            Open in finding review <ArrowRight className="h-4 w-4" />
          </button>
        </>
      )}
    </section>
  );
}
