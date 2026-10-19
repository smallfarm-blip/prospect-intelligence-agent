import { Gauge } from 'lucide-react';
import type { ProspectView } from '@/lib/prospectView';
import { formatDate, humanize } from '@/lib/format';
import { ConfidenceCoverage, ScoreRange } from '@/components/prospects/ScoreBits';

const STATUS_DOT: Record<string, string> = {
  verified: 'bg-success-500',
  provider_estimate: 'bg-secondary-400',
  inferred: 'bg-primary-400',
  unknown: 'bg-ink-300',
  contradicted: 'bg-error-500',
};

export function ScorePanel({ view }: { view: ProspectView }) {
  const s = view.score;
  if (!s) {
    return (
      <section className="card p-6">
        <div className="flex items-center gap-2 text-ink-500">
          <Gauge className="h-4 w-4" />
          <h2 className="label">Score</h2>
        </div>
        <p className="mt-3 text-sm text-ink-600">
          Not scored yet. Scores are calculated from collected evidence when the prospecting worker screens or rescores companies. Until then this company sits in the Not scored queue and deeper research cannot be approved.
        </p>
      </section>
    );
  }
  return (
    <section className="card p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-[220px] flex-1">
          <h2 className="label mb-2">Evidence-backed score</h2>
          <ScoreRange view={view} size="lg" />
          <div className="mt-2">
            <ConfidenceCoverage view={view} />
          </div>
          {view.scoreOverride && (
            <p className="mt-2 text-xs text-accent-700">
              Reviewer changed the score from {view.scoreOverride.previous_value ?? '-'} to {view.scoreOverride.new_value}: {view.scoreOverride.reason}
            </p>
          )}
        </div>
        <p className="text-xs text-ink-400">Computed {formatDate(s.computed_at)} · {s.scoring_version}</p>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {s.components.map((c) => (
          <div key={c.key} className="rounded-lg border border-ink-100 p-4">
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-ink-800">{c.label}</span>
              <span className="text-sm text-ink-500">
                <span className="font-semibold text-ink-900">{c.evidence}</span> / {c.max}
                <span className="ml-1 text-xs">(up to {c.potential})</span>
              </span>
            </div>
            <ul className="mt-3 space-y-2">
              {c.items.map((i) => (
                <li key={i.key} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-ink-700">
                      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[i.status] ?? 'bg-ink-300'}`} title={humanize(i.status)} />
                      {i.label}
                    </span>
                    <span className="tabular-nums text-ink-500">{i.evidence}/{i.max}</span>
                  </div>
                  {i.note && <p className="ml-3 mt-0.5 text-ink-500">{i.note}</p>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-3 flex flex-wrap gap-3 text-xs text-ink-500">
        {Object.entries(STATUS_DOT).map(([k, cls]) => (
          <span key={k} className="flex items-center gap-1"><span className={`h-1.5 w-1.5 rounded-full ${cls}`} />{humanize(k)}</span>
        ))}
      </p>
    </section>
  );
}
