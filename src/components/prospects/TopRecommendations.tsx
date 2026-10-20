import { ArrowRight, Compass, HelpCircle } from 'lucide-react';
import type { Recommendation } from '@/lib/prospectView';
import { ProspectBadges } from '@/components/prospects/ScoreBits';
import { NextActionBadge } from '@/components/prospects/NextActionPanel';

export function TopRecommendations({ items, scored, onOpen }: { items: Recommendation[]; scored: number; onOpen: (id: string) => void }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex items-center gap-2">
          <Compass className="h-4 w-4 text-accent-600" />
          <h2 className="label">Top 5 worth investigating next</h2>
        </div>
        <p className="text-xs text-ink-500">Ranked by investigation value and realistic consulting potential. These are research priorities, not outreach-ready leads.</p>
      </div>
      {items.length === 0 ? (
        <div className="card p-5 text-sm text-ink-500">
          {scored === 0
            ? 'Recommendations appear once companies have been scored from collected evidence. None have been scored yet.'
            : 'No open, scored companies to recommend. Companies on hold, deferred, already approved for research, set aside or marked Defer are left out.'}
        </div>
      ) : (
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {items.map((r, i) => {
            const na = r.view.nextAction;
            return (
              <li key={r.view.id}>
                <button
                  onClick={() => onOpen(r.view.id)}
                  className="card group flex h-full w-full flex-col gap-3 p-4 text-left transition hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-md"
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-900 text-xs font-semibold text-white">{i + 1}</span>
                    <span className="text-right">
                      <span className="block font-serif text-xl font-semibold leading-none text-ink-900">{r.view.scoreValue}</span>
                      <span className="text-[11px] text-ink-400">evidence score</span>
                    </span>
                  </div>
                  <div>
                    <div className="font-medium text-ink-900 group-hover:text-primary-700">{r.view.name}</div>
                    <div className="text-xs text-ink-500">{r.view.domain}</div>
                  </div>
                  <ProspectBadges view={r.view} withState={false} />
                  {na && (
                    <div className="space-y-2">
                      <NextActionBadge actionKey={na.key} overridden={!!na.override} />
                      {na.system?.explanation && <p className="line-clamp-4 text-xs leading-relaxed text-ink-600">{na.system.explanation}</p>}
                    </div>
                  )}
                  {r.reasons.length > 0 && (
                    <ul className="space-y-1 border-l-2 border-ink-100 pl-2 text-xs leading-relaxed text-ink-500">
                      {r.reasons.map((reason) => <li key={reason} className="line-clamp-2">{reason}</li>)}
                    </ul>
                  )}
                  {na?.system?.keyUnknown && (
                    <div className="mt-auto flex gap-1.5 rounded-lg bg-warning-50 px-3 py-2 text-xs text-ink-800">
                      <HelpCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning-700" />
                      <span className="line-clamp-3"><span className="font-medium">Key unknown: </span>{na.system.keyUnknown}</span>
                    </div>
                  )}
                  <span className="flex items-center gap-1 text-xs font-medium text-primary-700 opacity-0 transition group-hover:opacity-100">
                    Open company <ArrowRight className="h-3 w-3" />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
