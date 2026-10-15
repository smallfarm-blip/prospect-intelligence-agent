import { ArrowUpRight, GitBranch } from 'lucide-react';
import type { FindingView } from '@/lib/findingView';
import { Badge, DecisionBadge, VerificationBadge } from '@/components/ui';
import { humanize } from '@/lib/format';

export function FindingCard({ view, onOpen, index }: { view: FindingView; onOpen: () => void; index: number }) {
  const { finding, verification, reviews, revisedFrom } = view;
  const c = finding.content;
  return (
    <button
      onClick={onOpen}
      style={{ animationDelay: `${index * 50}ms` }}
      className="card group w-full animate-fade-up p-5 text-left transition hover:-translate-y-0.5 hover:border-ink-300 hover:shadow-md"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-ink-500">{finding.finding_ref}</span>
        <Badge tone="secondary">{humanize(finding.page_type)}</Badge>
        {finding.viewports.map((v) => <Badge key={v}>{v}</Badge>)}
        {revisedFrom && <Badge tone="accent" icon={<GitBranch className="h-3 w-3" />}>Revision of {revisedFrom.finding_ref}</Badge>}
      </div>
      <div className="mt-3 flex items-start justify-between gap-4">
        <h3 className="font-serif text-xl font-semibold text-ink-900">{finding.short_title}</h3>
        <ArrowUpRight className="h-5 w-5 shrink-0 text-ink-300 transition group-hover:text-primary-600" />
      </div>
      <p className="mt-2 line-clamp-2 text-sm text-ink-600">{c.decision_moment}</p>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <VerificationBadge status={verification?.status ?? null} />
        <DecisionBadge decision={reviews[0]?.decision ?? null} />
        <span className="ml-auto text-xs text-ink-500">
          {humanize(finding.confidence)} confidence / {finding.evidence_quality} evidence
        </span>
      </div>
    </button>
  );
}
