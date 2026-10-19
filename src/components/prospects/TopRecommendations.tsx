import { ArrowRight, Sparkles } from 'lucide-react';
import type { Recommendation } from '@/lib/prospectView';
import { ProspectBadges } from '@/components/prospects/ScoreBits';

export function TopRecommendations({ items, scored, onOpen }: { items: Recommendation[]; scored: number; onOpen: (id: string) => void }) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-accent-600" />
        <h2 className="label">Top 5 to look at next</h2>
      </div>
      {items.length === 0 ? (
        <div className="card p-5 text-sm text-ink-500">
          {scored === 0
            ? 'Recommendations appear once companies have been scored from collected evidence. None have been scored yet.'
            : 'No open, scored companies to recommend. Companies on hold, deferred, already approved for research or set aside are left out.'}
        </div>
      ) : (
        <ol className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {items.map((r, i) => (
            <li key={r.view.id}>
              <button
                onClick={() => onOpen(r.view.id)}
                className="card group flex h-full w-full flex-col gap-3 p-4 text-left transition hover:-translate-y-0.5 hover:border-primary-300 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink-900 text-xs font-semibold text-white">{i + 1}</span>
                  <span className="font-serif text-xl font-semibold text-ink-900">{r.view.scoreValue}</span>
                </div>
                <div>
                  <div className="font-medium text-ink-900 group-hover:text-primary-700">{r.view.name}</div>
                  <div className="text-xs text-ink-500">{r.view.domain}</div>
                </div>
                <ProspectBadges view={r.view} withState={false} />
                {r.reasons.length > 0 && (
                  <ul className="space-y-1 text-xs leading-relaxed text-ink-600">
                    {r.reasons.map((reason) => <li key={reason} className="line-clamp-3">{reason}</li>)}
                  </ul>
                )}
                <div className="mt-auto rounded-lg bg-accent-50 px-3 py-2 text-xs text-accent-800">
                  <span className="font-medium">Next: </span>
                  {r.nextAction}
                </div>
                <span className="flex items-center gap-1 text-xs font-medium text-primary-700 opacity-0 transition group-hover:opacity-100">
                  Open company <ArrowRight className="h-3 w-3" />
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
