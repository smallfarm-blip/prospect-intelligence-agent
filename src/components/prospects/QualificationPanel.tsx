import { AlertTriangle, CheckCircle2, HelpCircle, Scale } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { ProspectScore } from '@/lib/prospectTypes';
import { LEVEL_META } from '@/components/prospects/labels';

export function QualificationPanel({ score }: { score: ProspectScore }) {
  const q = score.qualification;
  return (
    <section className="space-y-4">
      {q?.fitBasis && q.fitBasis.length > 0 && (
        <div className="card p-5">
          <h2 className="label">Why this fit status</h2>
          <ul className="mt-2 space-y-1 text-sm text-ink-700">
            {q.fitBasis.map((b) => <li key={b}>{b}</li>)}
          </ul>
        </div>
      )}

      {!q ? (
        <div className="card p-5 text-sm text-ink-500">This score was computed before the four separate assessments existed. Rescoring will add them.</div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {q.assessments.map((a) => (
            <div key={a.key} className="card p-5">
              <div className="flex items-center justify-between gap-2">
                <h3 className="font-medium text-ink-900">{a.label}</h3>
                <Badge tone={LEVEL_META[a.level].tone}>{LEVEL_META[a.level].label}</Badge>
              </div>
              <List icon={<CheckCircle2 className="h-3.5 w-3.5 text-success-600" />} title="Strengths" items={a.strengths} />
              <List icon={<AlertTriangle className="h-3.5 w-3.5 text-warning-600" />} title="Risks" items={a.risks} />
              <List icon={<HelpCircle className="h-3.5 w-3.5 text-ink-400" />} title="Unknowns" items={a.unknowns} />
            </div>
          ))}
        </div>
      )}

      {q && q.tradeOffs.length > 0 && (
        <div className="card border-accent-200 bg-accent-50/40 p-5">
          <div className="flex items-center gap-2">
            <Scale className="h-4 w-4 text-accent-700" />
            <h2 className="label text-accent-800">Trade-offs</h2>
          </div>
          <ul className="mt-2 space-y-1.5 text-sm text-ink-700">
            {q.tradeOffs.map((t) => <li key={t}>{t}</li>)}
          </ul>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-5">
          <h2 className="label">Reasons to investigate</h2>
          {score.reasons_to_investigate.length === 0 ? <p className="mt-2 text-sm text-ink-500">None recorded.</p> : (
            <ul className="mt-2 space-y-1 text-sm text-ink-700">{score.reasons_to_investigate.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
        </div>
        <div className="card p-5">
          <h2 className="label">Still unresolved</h2>
          {score.unresolved.length === 0 ? <p className="mt-2 text-sm text-ink-500">Nothing outstanding.</p> : (
            <ul className="mt-2 space-y-1 text-sm text-ink-700">{score.unresolved.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
        </div>
      </div>
      {score.recommended_action && (
        <div className="rounded-xl bg-ink-900 px-5 py-4 text-sm text-white">
          <span className="font-medium text-accent-200">Recommended next research: </span>
          {score.recommended_action}
        </div>
      )}
    </section>
  );
}

function List({ icon, title, items }: { icon: React.ReactNode; title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <div className="flex items-center gap-1.5 text-xs font-medium text-ink-600">{icon}{title}</div>
      <ul className="ml-5 mt-1 list-disc space-y-0.5 text-sm text-ink-700">
        {items.map((i) => <li key={i}>{i}</li>)}
      </ul>
    </div>
  );
}
