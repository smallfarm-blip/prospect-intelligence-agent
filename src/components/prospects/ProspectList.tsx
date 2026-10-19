import { ChevronRight, SearchX } from 'lucide-react';
import type { ProspectView } from '@/lib/prospectView';
import { ConfidenceCoverage, ProspectBadges, ScoreRange } from '@/components/prospects/ScoreBits';
import { ORIGIN_LABELS } from '@/components/prospects/labels';
import { humanize } from '@/lib/format';

export function ProspectList({ views, onOpen, total }: { views: ProspectView[]; onOpen: (id: string) => void; total: number }) {
  if (views.length === 0) {
    return (
      <div className="card flex flex-col items-center p-10 text-center">
        <SearchX className="h-7 w-7 text-ink-300" />
        <p className="mt-3 text-sm text-ink-500">No companies match these filters{total ? ` (out of ${total})` : ''}.</p>
      </div>
    );
  }
  return (
    <ul className="card divide-y divide-ink-100 overflow-hidden">
      {views.map((v) => (
        <li key={v.id}>
          <button onClick={() => onOpen(v.id)} className="group grid w-full gap-4 px-5 py-4 text-left transition hover:bg-ink-50 md:grid-cols-[minmax(0,1fr)_200px_24px] md:items-center">
            <div className="min-w-0 space-y-1.5">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-ink-900 group-hover:text-primary-700">{v.name}</span>
                <span className="text-sm text-ink-500">{v.domain}</span>
              </div>
              <ProspectBadges view={v} />
              <p className="line-clamp-1 text-sm text-ink-500">
                {v.prospect.excluded_reason ?? v.prospect.description ?? v.prospect.companies?.category ?? ORIGIN_LABELS[v.prospect.origin] ?? humanize(v.prospect.origin)}
              </p>
            </div>
            <div className="space-y-1.5">
              <ScoreRange view={v} />
              <ConfidenceCoverage view={v} />
            </div>
            <ChevronRight className="hidden h-5 w-5 text-ink-300 transition group-hover:translate-x-0.5 group-hover:text-primary-600 md:block" />
          </button>
        </li>
      ))}
    </ul>
  );
}
