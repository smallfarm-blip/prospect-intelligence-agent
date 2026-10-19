import { UserPen } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { ProspectView } from '@/lib/prospectView';
import { CONFIDENCE_TONE, QUEUE_META, SEGMENT_META, STATE_META } from '@/components/prospects/labels';

/** Evidence score as a solid bar, with the possible range shaded behind it. */
export function ScoreRange({ view, size = 'sm' }: { view: ProspectView; size?: 'sm' | 'lg' }) {
  const s = view.score;
  if (!s || view.scoreValue === null) return <span className="text-sm text-ink-400">Not scored</span>;
  const lo = Math.min(view.scoreValue, s.potential_min);
  const hi = Math.max(view.scoreValue, s.potential_max);
  return (
    <div className={size === 'lg' ? 'space-y-2' : 'space-y-1'}>
      <div className="flex items-baseline gap-2">
        <span className={`font-serif font-semibold text-ink-900 ${size === 'lg' ? 'text-4xl' : 'text-xl'}`}>{view.scoreValue}</span>
        <span className="text-xs text-ink-500">range {s.potential_min}-{s.potential_max}</span>
        {view.scoreOverride && <UserPen className="h-3.5 w-3.5 text-accent-600" aria-label="Score changed by a reviewer" />}
      </div>
      <div className={`relative w-full overflow-hidden rounded-full bg-ink-100 ${size === 'lg' ? 'h-2.5' : 'h-1.5'}`}>
        <div className="absolute inset-y-0 rounded-full bg-primary-200" style={{ left: `${lo}%`, width: `${Math.max(1, hi - lo)}%` }} />
        <div className="absolute inset-y-0 left-0 rounded-full bg-primary-600 transition-all duration-500" style={{ width: `${view.scoreValue}%` }} />
      </div>
    </div>
  );
}

export function ProspectBadges({ view, withState = true }: { view: ProspectView; withState?: boolean }) {
  const q = QUEUE_META[view.queue];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Badge tone={q.tone} icon={view.fitOverride ? <UserPen className="h-3 w-3" /> : undefined}>{q.label}</Badge>
      {view.segments.map((s) => <Badge key={s} tone={SEGMENT_META[s].tone}>{SEGMENT_META[s].label}</Badge>)}
      {withState && view.state !== 'open' && <Badge tone={STATE_META[view.state].tone}>{STATE_META[view.state].label}</Badge>}
    </div>
  );
}

export function ConfidenceCoverage({ view }: { view: ProspectView }) {
  if (!view.score) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs text-ink-500">
      <Badge tone={CONFIDENCE_TONE[view.score.confidence]}>{view.score.confidence} confidence</Badge>
      <span>{Math.round(Number(view.score.coverage) * 100)}% of evidence collected</span>
    </div>
  );
}
