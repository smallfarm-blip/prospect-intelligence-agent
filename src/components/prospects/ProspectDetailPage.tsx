import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { loadProspectDetail } from '@/lib/prospectApi';
import type { ProspectBoard, ProspectDetail } from '@/lib/prospectTypes';
import { estimateResearchCost, type ProspectView } from '@/lib/prospectView';
import { formatDate, humanize } from '@/lib/format';
import { Badge, ErrorNote, Spinner } from '@/components/ui';
import { ORIGIN_LABELS } from '@/components/prospects/labels';
import { ProspectBadges } from '@/components/prospects/ScoreBits';
import { ScorePanel } from '@/components/prospects/ScorePanel';
import { QualificationPanel } from '@/components/prospects/QualificationPanel';
import { EvidenceTabs, Ext } from '@/components/prospects/EvidenceTabs';
import { ExistingResearch, HistoryPanel } from '@/components/prospects/HistoryPanel';
import { ReviewActions } from '@/components/prospects/ReviewActions';
import { NextActionPanel } from '@/components/prospects/NextActionPanel';

interface Props {
  view: ProspectView;
  board: ProspectBoard;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onOpenResearch: (companyId: string) => void;
}

type DetailState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; detail: ProspectDetail };

export function ProspectDetailPage({ view, board, onBack, onChanged, onOpenResearch }: Props) {
  const [state, setState] = useState<DetailState>({ status: 'loading' });
  const [openedAt] = useState(() => Date.now());
  const estimate = useMemo(() => estimateResearchCost(board.research), [board.research]);
  const p = view.prospect;

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    loadProspectDetail(view.id)
      .then((detail) => live && setState({ status: 'ready', detail }))
      .catch((e: Error) => live && setState({ status: 'error', message: e.message }));
    return () => {
      live = false;
    };
  }, [view.id]);

  return (
    <div className="space-y-6 animate-fade-up">
      <button className="btn-ghost -ml-3" onClick={onBack}>
        <ArrowLeft className="h-4 w-4" /> All prospects
      </button>

      <header className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-serif text-3xl font-semibold text-ink-900">{view.name}</h1>
          {view.domain && <Ext href={`https://${view.domain}`}>{view.domain}</Ext>}
        </div>
        <ProspectBadges view={view} />
        <div className="flex flex-wrap gap-1.5">
          <Badge>{ORIGIN_LABELS[p.origin] ?? humanize(p.origin)}</Badge>
          {p.companies?.category && <Badge>{p.companies.category}</Badge>}
          {p.companies?.geography && <Badge>{p.companies.geography}</Badge>}
          <Badge>Added {formatDate(p.created_at)}</Badge>
          <Badge>{p.screened_at ? `Screened ${formatDate(p.screened_at)}` : 'Not screened yet'}</Badge>
        </div>
        {(p.description || p.screening_summary) && <p className="max-w-3xl text-sm text-ink-600">{p.screening_summary ?? p.description}</p>}
        {p.excluded_reason && <ErrorNote message={`Excluded at screening: ${p.excluded_reason}`} />}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-6">
          <NextActionPanel view={view} onChanged={onChanged} />
          <ScorePanel view={view} />
          {view.score && <QualificationPanel score={view.score} />}
          {state.status === 'loading' && <Spinner label="Loading sources, people and signals..." />}
          {state.status === 'error' && <ErrorNote message={state.message} />}
          {state.status === 'ready' && <EvidenceTabs detail={state.detail} />}
        </div>
        <aside className="space-y-6">
          <ReviewActions view={view} estimate={estimate} openedAt={openedAt} onChanged={onChanged} />
          <ExistingResearch view={view} onOpenResearch={onOpenResearch} />
          <HistoryPanel view={view} board={board} />
        </aside>
      </div>
    </div>
  );
}
