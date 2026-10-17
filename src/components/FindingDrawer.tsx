import { useEffect, useState } from 'react';
import { GitBranch, X } from 'lucide-react';
import type { FindingView } from '@/lib/findingView';
import { citedImages, citedPages, imageUrl, isLegacyFinding } from '@/lib/findingView';
import type { AssessmentOverride, ReadinessDecision, Review, RunDetail } from '@/lib/types';
import { FindingDetails } from '@/components/FindingDetails';
import { CitedImageView, StateComparison } from '@/components/EvidenceViews';
import { VerificationPanel } from '@/components/VerificationPanel';
import { ReviewPanel } from '@/components/ReviewPanel';
import { AssessmentControls } from '@/components/AssessmentControls';
import { Badge, ClassBadge, DecisionBadge, EvidenceBadge, PriorityBadge, ReadinessBadge, VerificationBadge } from '@/components/ui';
import { captureStateLabel } from '@/lib/captureStates';

const TABS = ['Finding', 'Evidence', 'Verification', 'Assessment', 'Your review'] as const;
type Tab = (typeof TABS)[number];

interface Props {
  view: FindingView;
  detail: RunDetail;
  urls: Record<string, string>;
  onClose: () => void;
  onOpenFinding: (id: string) => void;
  onReviewSaved: (r: Review) => void;
  onOverrideSaved: (o: AssessmentOverride) => void;
  onReadinessSaved: (r: ReadinessDecision) => void;
}

export function FindingDrawer({ view, detail, urls, onClose, onOpenFinding, onReviewSaved, onOverrideSaved, onReadinessSaved }: Props) {
  const [tab, setTab] = useState<Tab>('Finding');
  const { finding, verification, reviews, revisedFrom, revisions, assessment } = view;
  const legacy = isLegacyFinding(finding);

  useEffect(() => {
    setTab('Finding');
  }, [finding.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const images = citedImages(detail, finding);
  const pages = citedPages(detail, finding);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-ink-900/30 backdrop-blur-[2px]" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-4xl animate-slide-in flex-col bg-ink-50 shadow-2xl">
        <header className="border-b border-ink-200 bg-white px-6 pt-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="font-mono text-xs text-ink-500">{finding.finding_ref}</p>
              <h2 className="mt-1 font-serif text-2xl font-semibold text-ink-900">{finding.short_title}</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {legacy ? (
                  <>
                    <VerificationBadge status={verification?.status ?? null} />
                    <Badge>Earlier format</Badge>
                  </>
                ) : (
                  <>
                    <EvidenceBadge status={verification?.evidence_status ?? verification?.status ?? null} legacy={!verification?.evidence_status} />
                    <ClassBadge value={assessment.findingClass.value} byReviewer={assessment.findingClass.source === 'reviewer'} />
                    <PriorityBadge value={assessment.priority.value} byReviewer={assessment.priority.source === 'reviewer'} />
                  </>
                )}
                <ReadinessBadge value={assessment.outreach} />
                <DecisionBadge decision={reviews[0]?.decision ?? null} />
              </div>
            </div>
            <button onClick={onClose} className="btn-ghost p-2" aria-label="Close">
              <X className="h-5 w-5" />
            </button>
          </div>
          {(revisedFrom || revisions.length > 0) && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-600">
              <GitBranch className="h-3.5 w-3.5" />
              {revisedFrom && (
                <button className="font-medium text-primary-700 hover:underline" onClick={() => onOpenFinding(revisedFrom.id)}>
                  Revised from {revisedFrom.finding_ref}
                </button>
              )}
              {revisions.map((r) => (
                <button key={r.id} className="font-medium text-primary-700 hover:underline" onClick={() => onOpenFinding(r.id)}>
                  Revised as {r.finding_ref}
                </button>
              ))}
            </div>
          )}
          <nav className="mt-4 flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`whitespace-nowrap border-b-2 px-3 pb-3 text-sm font-medium transition ${
                  tab === t ? 'border-primary-600 text-primary-800' : 'border-transparent text-ink-500 hover:text-ink-800'
                }`}
              >
                {t}
                {t === 'Evidence' && <span className="ml-1 text-xs text-ink-400">({images.length})</span>}
              </button>
            ))}
          </nav>
        </header>

        <div key={tab} className="flex-1 animate-fade-up overflow-y-auto px-6 py-6">
          {tab === 'Finding' && <FindingDetails content={finding.content} />}
          {tab === 'Evidence' && (
            <div className="space-y-8">
              <section className="space-y-4">
                <p className="label">Cited screenshots (highlighted areas are the cited regions)</p>
                {images.length === 0 && <p className="text-sm text-ink-500">This finding cites page text only.</p>}
                <div className="grid gap-6 md:grid-cols-2">
                  {images.map((c) => <CitedImageView key={c.image.id} cited={c} url={imageUrl(c.image, urls)} />)}
                </div>
              </section>
              <section className="space-y-4">
                <p className="label">
                  {captureStateLabel('initial_viewport')} vs {captureStateLabel('after_overlay_dismissal').toLowerCase()}, for the pages involved
                </p>
                {pages.map((p) => <StateComparison key={p.id} page={p} urls={urls} />)}
              </section>
            </div>
          )}
          {tab === 'Verification' && <VerificationPanel verification={verification} />}
          {tab === 'Assessment' && <AssessmentControls view={view} onOverrideSaved={onOverrideSaved} onReadinessSaved={onReadinessSaved} />}
          {tab === 'Your review' && <ReviewPanel findingId={finding.id} reviews={reviews} onSaved={onReviewSaved} />}
        </div>
      </div>
    </div>
  );
}
