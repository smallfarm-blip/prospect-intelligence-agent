import { useState } from 'react';
import { FlaskConical, PencilLine, ShieldCheck } from 'lucide-react';
import { submitProspectDecision, submitProspectOverride } from '@/lib/prospectApi';
import { FIT_STATUSES, type FitStatus, type ProspectDecisionKind } from '@/lib/prospectTypes';
import { availableActions, fitOverrideProblem, reasonProblem, REASON_MAX, scoreOverrideProblem, type CostEstimate, type ProspectView } from '@/lib/prospectView';
import { formatDate, usd } from '@/lib/format';
import { Badge, ErrorNote } from '@/components/ui';
import { Modal } from '@/components/prospects/Modal';
import { ACTION_META, FIT_LABELS, STATE_META } from '@/components/prospects/labels';

interface Props {
  view: ProspectView;
  estimate: CostEstimate;
  openedAt: number;
  onChanged: () => Promise<void>;
}

const ACTION_STYLE: Partial<Record<ProspectDecisionKind, string>> = {
  request_research: 'btn-primary',
  reject: 'btn border border-error-200 text-error-700 hover:bg-error-50',
};

export function ReviewActions({ view, estimate, openedAt, onChanged }: Props) {
  const [action, setAction] = useState<ProspectDecisionKind | null>(null);
  const [overriding, setOverriding] = useState(false);
  const actions = availableActions(view);

  return (
    <section className="card p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="label">Review</h2>
        <Badge tone={STATE_META[view.state].tone}>{STATE_META[view.state].label}</Badge>
      </div>
      {view.decision && (
        <p className="mt-2 text-sm text-ink-600">
          <span className="font-medium text-ink-800">{ACTION_META[view.decision.decision].label}</span> on {formatDate(view.decision.created_at)}: {view.decision.reason}
        </p>
      )}
      {view.setAside && view.state !== 'rejected' && (
        <p className="mt-2 text-sm text-ink-600">
          {view.prospect.excluded_reason ? `Excluded at screening: ${view.prospect.excluded_reason}.` : 'Scored as not a fit.'} Reopen it to review further.
        </p>
      )}
      <div className="mt-4 grid gap-2">
        {actions.map((a) => (
          <button key={a} className={`${ACTION_STYLE[a] ?? 'btn border border-ink-200 bg-white text-ink-700 hover:bg-ink-50'} w-full`} onClick={() => setAction(a)}>
            {a === 'request_research' && <FlaskConical className="h-4 w-4" />}
            {ACTION_META[a].label}
            {a === 'request_research' && <span className="text-xs opacity-80">~{usd(estimate.usd, 2)}</span>}
          </button>
        ))}
        {view.fit === null && <p className="text-xs text-ink-500">Deeper research can be approved once the company has a score.</p>}
      </div>
      <button className="btn-ghost mt-3 w-full" onClick={() => setOverriding(true)} disabled={!view.score}>
        <PencilLine className="h-4 w-4" /> Change score or fit status
      </button>

      {action && <DecisionDialog view={view} action={action} estimate={estimate} openedAt={openedAt} onClose={() => setAction(null)} onSaved={onChanged} />}
      {overriding && <OverrideDialog view={view} onClose={() => setOverriding(false)} onSaved={onChanged} />}
    </section>
  );
}

export function ReasonField({ value, onChange, prompt }: { value: string; onChange: (v: string) => void; prompt: string }) {
  return (
    <label className="block">
      <span className="label">Reason</span>
      <textarea className="field mt-1 min-h-[96px]" maxLength={REASON_MAX} placeholder={prompt} value={value} onChange={(e) => onChange(e.target.value)} autoFocus />
      <span className="mt-1 block text-right text-xs text-ink-400">{value.trim().length} / at least 10 characters</span>
    </label>
  );
}

function DecisionDialog({ view, action, estimate, openedAt, onClose, onSaved }: { view: ProspectView; action: ProspectDecisionKind; estimate: CostEstimate; openedAt: number; onClose: () => void; onSaved: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const research = action === 'request_research';
  const problem = reasonProblem(reason) ?? (research && !confirmed ? 'Confirm the estimated cost' : null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await submitProspectDecision({ companyId: view.id, decision: action, reason, expectedCostUsd: research ? estimate.usd : null, reviewSeconds: (Date.now() - openedAt) / 1000 });
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal title={`${ACTION_META[action].label}: ${view.name}`} onClose={onClose}>
      <div className="space-y-4">
        {research && (
          <div className="rounded-lg border border-accent-200 bg-accent-50 p-4 text-sm">
            <div className="flex items-baseline justify-between">
              <span className="font-medium text-accent-800">Estimated cost</span>
              <span className="font-serif text-2xl font-semibold text-ink-900">{usd(estimate.usd, 2)}</span>
            </div>
            <p className="mt-1 text-xs text-ink-600">{estimate.basis}. Covers a site capture and an AI analysis of the storefront.</p>
            <p className="mt-3 flex items-start gap-2 text-xs text-ink-700">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary-700" />
              Approving only records your decision. Nothing is captured, searched or analysed, and nothing is charged, until the research is started separately.
            </p>
            <label className="mt-3 flex items-center gap-2 text-sm text-ink-800">
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="h-4 w-4 rounded border-ink-300 text-primary-700" />
              I approve spending about {usd(estimate.usd, 2)} on this company
            </label>
          </div>
        )}
        <ReasonField value={reason} onChange={setReason} prompt={ACTION_META[action].prompt} />
        {error && <ErrorNote message={error} />}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!!problem || saving} onClick={save} title={problem ?? undefined}>
            {saving ? 'Saving...' : ACTION_META[action].label}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function OverrideDialog({ view, onClose, onSaved }: { view: ProspectView; onClose: () => void; onSaved: () => Promise<void> }) {
  const [field, setField] = useState<'score' | 'fit_status'>('score');
  const [score, setScore] = useState(String(view.scoreValue ?? ''));
  const [fit, setFit] = useState<FitStatus>(view.fit ?? 'needs_qualification');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const valueProblem = field === 'score' ? scoreOverrideProblem(score, view.scoreValue) : fitOverrideProblem(fit, view.fit);
  const problem = valueProblem ?? reasonProblem(reason);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await submitProspectOverride({ companyId: view.id, field, newValue: field === 'score' ? score.trim() : fit, reason });
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal title={`Change score or fit: ${view.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {(['score', 'fit_status'] as const).map((f) => (
            <button key={f} onClick={() => setField(f)} className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${field === f ? 'border-primary-600 bg-primary-50 text-primary-800' : 'border-ink-200 text-ink-600 hover:bg-ink-50'}`}>
              {f === 'score' ? 'Score' : 'Fit status'}
            </button>
          ))}
        </div>
        {field === 'score' ? (
          <label className="block">
            <span className="label">New score (currently {view.scoreValue})</span>
            <input className="field mt-1" inputMode="numeric" value={score} onChange={(e) => setScore(e.target.value)} />
          </label>
        ) : (
          <label className="block">
            <span className="label">New fit status (currently {view.fit ? FIT_LABELS[view.fit] : '-'})</span>
            <select className="field mt-1" value={fit} onChange={(e) => setFit(e.target.value as FitStatus)}>
              {FIT_STATUSES.map((f) => <option key={f} value={f}>{FIT_LABELS[f]}</option>)}
            </select>
          </label>
        )}
        <ReasonField value={reason} onChange={setReason} prompt="What evidence supports this change?" />
        <p className="text-xs text-ink-500">The computed score is kept alongside your change, and both stay in the history.</p>
        {valueProblem && <p className="text-xs text-warning-700">{valueProblem}</p>}
        {error && <ErrorNote message={error} />}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" disabled={!!problem || saving} onClick={save} title={problem ?? undefined}>{saving ? 'Saving...' : 'Save change'}</button>
        </div>
      </div>
    </Modal>
  );
}
