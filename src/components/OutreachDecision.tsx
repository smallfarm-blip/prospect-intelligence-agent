import { useState, type FormEvent } from 'react';
import { Ban, Megaphone, Quote, Save, ShieldAlert } from 'lucide-react';
import { submitReadiness } from '@/lib/reviewApi';
import type { FindingView } from '@/lib/findingView';
import type { OutreachReadiness, ReadinessDecision } from '@/lib/types';
import { MIN_WORDING, READINESS_LABELS, READINESS_OPTIONS, readinessAllowed } from '@/lib/assessment';
import { ErrorNote, ReadinessBadge } from '@/components/ui';
import { formatDate } from '@/lib/format';

const MIN_REASON = 10;

const CONFIRMATIONS = [
  { key: 'decisionMaker', text: 'Relevant to a Head of eCommerce or a similar decision-maker.' },
  { key: 'grounded', text: "Grounded in this finding's specific evidence, not general best practice." },
  { key: 'noOverstatement', text: 'Does not overstate the observed friction or the business impact.' },
] as const;
type ConfirmKey = (typeof CONFIRMATIONS)[number]['key'] | 'uncertainty';

function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm text-ink-700">
      <input type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-primary-600" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function OutreachDecision({ view, onSaved }: { view: FindingView; onSaved: (r: ReadinessDecision) => void }) {
  const [value, setValue] = useState<OutreachReadiness | null>(null);
  const [wording, setWording] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState<Record<ConfirmKey, boolean>>({ decisionMaker: false, grounded: false, noOverstatement: false, uncertainty: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const cls = view.assessment.findingClass.value;
  const current = view.assessment.outreach;
  const approving = value === 'exploratory' || value === 'ready';
  const wordingOk = wording.trim().length >= MIN_WORDING;
  const confirmsOk = CONFIRMATIONS.every((c) => confirmed[c.key]) && (value !== 'exploratory' || confirmed.uncertainty);
  const canSubmit = !!value && value !== current && readinessAllowed(value, cls) && reason.trim().length >= MIN_REASON && (!approving || (wordingOk && confirmsOk)) && !busy;

  const hint: Record<OutreachReadiness, string> = {
    not_ready: 'Keep this out of any outreach. Every finding starts here.',
    exploratory: readinessAllowed('exploratory', cls) ? 'Raise as an open question, never as a proven problem.' : 'Needs a research hypothesis or evidence-backed class first.',
    ready: readinessAllowed('ready', cls) ? 'Only for evidence-backed opportunities you have checked yourself.' : 'Only evidence-backed opportunities can be ready.',
  };

  const reset = () => {
    setValue(null);
    setWording('');
    setReason('');
    setConfirmed({ decisionMaker: false, grounded: false, noOverstatement: false, uncertainty: false });
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await submitReadiness({
        findingId: view.finding.id,
        readiness: value,
        reason,
        proposedWording: approving ? wording : null,
        uncertaintyConfirmed: confirmed.uncertainty,
        decisionMakerRelevanceConfirmed: confirmed.decisionMaker,
        evidenceGroundedConfirmed: confirmed.grounded,
        noOverstatementConfirmed: confirmed.noOverstatement,
      });
      onSaved(saved);
      reset();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (k: ConfirmKey) => (v: boolean) => setConfirmed((c) => ({ ...c, [k]: v }));

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="card space-y-4 p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="label flex items-center gap-2"><Megaphone className="h-3.5 w-3.5" /> Outreach readiness</p>
          <ReadinessBadge value={current} />
        </div>
        <p className="flex items-start gap-2 text-xs text-ink-500">
          <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          This records an approval only. Nothing here sends, schedules or writes messages to prospects.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {READINESS_OPTIONS.map((r) => (
            <button
              type="button"
              key={r}
              disabled={!readinessAllowed(r, cls) || r === current}
              onClick={() => setValue(r)}
              className={`rounded-lg border px-3 py-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${
                value === r ? 'border-primary-500 bg-primary-50 text-primary-800' : 'border-ink-200 text-ink-700 hover:border-ink-300 hover:bg-ink-50'
              }`}
            >
              <span className="block font-medium">{READINESS_LABELS[r]}{r === current && ' (current)'}</span>
              <span className="mt-1 block text-xs text-ink-500">{hint[r]}</span>
            </button>
          ))}
        </div>

        {approving && (
          <div className="animate-fade-up space-y-4">
            <label className="block space-y-1">
              <span className="label">Proposed outreach wording (required)</span>
              <textarea
                className="field min-h-[120px]"
                maxLength={2000}
                value={wording}
                onChange={(e) => setWording(e.target.value)}
                placeholder={
                  value === 'exploratory'
                    ? 'e.g. "Looking at your shade pages, we wondered whether shoppers comparing undertones find what they need. We have not tested this yet..."'
                    : 'The exact angle you would use with this prospect'
                }
              />
              <span className="text-xs text-ink-500">
                {wordingOk ? `${wording.trim().length} characters` : `At least ${MIN_WORDING} characters. Stored with this decision so the angle can be evaluated later.`}
              </span>
            </label>
            <div className="space-y-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
              <p className="label">I confirm the wording is</p>
              {CONFIRMATIONS.map((c) => <Check key={c.key} checked={confirmed[c.key]} onChange={toggle(c.key)}>{c.text}</Check>)}
            </div>
            {value === 'exploratory' && (
              <div className="rounded-lg border border-warning-200 bg-warning-50 p-3">
                <p className="mb-2 flex items-center gap-1 text-sm font-medium text-warning-700"><ShieldAlert className="h-4 w-4" /> Exploratory outreach only</p>
                <Check checked={confirmed.uncertainty} onChange={toggle('uncertainty')}>
                  The wording says plainly that this is unconfirmed, and claims no proven friction, lost sales or revenue impact.
                </Check>
              </div>
            )}
          </div>
        )}

        {value && (
          <label className="block animate-fade-up space-y-1">
            <span className="label">Reason for this decision (required)</span>
            <textarea className="field min-h-[72px]" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this the right outreach status?" />
          </label>
        )}
        {error && <ErrorNote message={error} />}
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="animate-fade-up text-sm text-success-700">Saved</span>}
          <button className="btn-primary" disabled={!canSubmit}>
            <Save className="h-4 w-4" /> {busy ? 'Saving...' : 'Save outreach decision'}
          </button>
        </div>
      </form>

      <section className="space-y-2">
        <p className="label">Outreach decision history</p>
        {view.readiness.length === 0 ? (
          <p className="text-sm text-ink-400">No decisions yet, so this finding is Not ready.</p>
        ) : (
          <ul className="space-y-2">
            {view.readiness.map((r) => (
              <li key={r.id} className="rounded-lg border border-ink-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <ReadinessBadge value={r.readiness} />
                  <span className="ml-auto text-xs text-ink-400">{formatDate(r.created_at)}</span>
                </div>
                {r.proposed_wording && (
                  <blockquote className="mt-2 flex gap-2 rounded-md bg-ink-50 p-3 font-serif text-ink-800">
                    <Quote className="h-4 w-4 shrink-0 text-ink-400" />
                    <span className="whitespace-pre-wrap">{r.proposed_wording}</span>
                  </blockquote>
                )}
                <p className="mt-2 whitespace-pre-wrap text-ink-700">{r.reason}</p>
                {r.readiness !== 'not_ready' && (
                  <p className="mt-2 text-xs text-ink-500">
                    Confirmed: decision-maker relevance, grounded in evidence, no overstatement{r.uncertainty_confirmed ? ', states uncertainty' : ''}.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
