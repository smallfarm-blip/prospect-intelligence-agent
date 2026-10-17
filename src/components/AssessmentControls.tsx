import { useState, type FormEvent, type ReactNode } from 'react';
import { Lock, Megaphone, Save, ShieldAlert } from 'lucide-react';
import { submitOverride, submitReadiness } from '@/lib/reviewApi';
import type { FindingView } from '@/lib/findingView';
import type { AssessmentField, AssessmentOverride, OutreachReadiness, ReadinessDecision } from '@/lib/types';
import { CLASS_DESCRIPTIONS, CLASS_LABELS, CLASSES, PRIORITIES, PRIORITY_LABELS, READINESS_LABELS, SOURCE_LABELS, fieldValueLabel, type Effective } from '@/lib/assessment';
import { ClassBadge, ErrorNote, PriorityBadge, ReadinessBadge } from '@/components/ui';
import { formatDate } from '@/lib/format';

const MIN_REASON = 10;

interface Props {
  view: FindingView;
  onOverrideSaved: (o: AssessmentOverride) => void;
  onReadinessSaved: (r: ReadinessDecision) => void;
}

export function AssessmentControls({ view, onOverrideSaved, onReadinessSaved }: Props) {
  const { assessment, overrides, readiness, finding } = view;
  return (
    <div className="space-y-8">
      <p className="flex items-start gap-2 rounded-lg border border-ink-200 bg-white p-3 text-xs text-ink-600">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        You can change how this finding is classed and prioritised, and decide whether it may be used for outreach. The screenshots, page text,
        automatic checks and verifier results stay exactly as recorded. Every change is kept in the history below and cannot be edited.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <OverrideForm
          findingId={finding.id}
          field="finding_class"
          title="Evidence maturity"
          current={assessment.findingClass}
          badge={<ClassBadge value={assessment.findingClass.value} byReviewer={assessment.findingClass.source === 'reviewer'} />}
          onSaved={onOverrideSaved}
        />
        <OverrideForm
          findingId={finding.id}
          field="investigation_priority"
          title="Investigation priority"
          current={assessment.priority}
          badge={<PriorityBadge value={assessment.priority.value} byReviewer={assessment.priority.source === 'reviewer'} />}
          onSaved={onOverrideSaved}
        />
      </div>

      <ReadinessForm view={view} onSaved={onReadinessSaved} />

      <section className="space-y-2">
        <p className="label">Classification history</p>
        {overrides.length === 0 ? (
          <p className="text-sm text-ink-400">No reviewer changes. The values above are the system's.</p>
        ) : (
          <ul className="space-y-2">
            {overrides.map((o) => (
              <li key={o.id} className="rounded-lg border border-ink-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-ink-700">
                  <span className="font-medium">{o.field === 'finding_class' ? 'Maturity' : 'Priority'}:</span>
                  <span className="text-ink-500 line-through">{fieldValueLabel(o.field, o.previous_value)}</span>
                  <span aria-hidden>to</span>
                  <span className="font-medium">{fieldValueLabel(o.field, o.new_value)}</span>
                  <span className="ml-auto text-xs text-ink-400">{formatDate(o.created_at)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-ink-700">{o.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <p className="label">Outreach decision history</p>
        {readiness.length === 0 ? (
          <p className="text-sm text-ink-400">No outreach decision yet. Nothing becomes outreach-ready without one.</p>
        ) : (
          <ul className="space-y-2">
            {readiness.map((r) => (
              <li key={r.id} className="rounded-lg border border-ink-200 bg-white p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <ReadinessBadge value={r.readiness} />
                  {r.uncertainty_confirmed && <span className="text-xs text-ink-600">Uncertainty wording confirmed</span>}
                  <span className="ml-auto text-xs text-ink-400">{formatDate(r.created_at)}</span>
                </div>
                <p className="mt-2 whitespace-pre-wrap text-ink-700">{r.reason}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, saved, run };
}

function OverrideForm({ findingId, field, title, current, badge, onSaved }: {
  findingId: string;
  field: AssessmentField;
  title: string;
  current: Effective<string>;
  badge: ReactNode;
  onSaved: (o: AssessmentOverride) => void;
}) {
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const { busy, error, saved, run } = useSubmit();
  const isClass = field === 'finding_class';
  const options = isClass ? CLASSES.map((c) => ({ value: c, label: CLASS_LABELS[c] })) : PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
  const canSubmit = !!value && value !== current.value && reason.trim().length >= MIN_REASON && !busy;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      onSaved(await submitOverride({ findingId, field, newValue: value, reason }));
      setValue('');
      setReason('');
    });
  };

  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="label">{title}</p>
        {badge}
      </div>
      <p className="text-xs text-ink-500">
        {current.source ? `Currently ${SOURCE_LABELS[current.source]}.` : 'Not set for this finding.'}
        {current.source === 'reviewer' && ` System value: ${fieldValueLabel(field, current.system)}.`}
      </p>
      <select className="field" value={value} onChange={(e) => setValue(e.target.value)} aria-label={`New ${title.toLowerCase()}`}>
        <option value="">Change to...</option>
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.value === current.value}>{o.label}</option>
        ))}
      </select>
      {isClass && value && <p className="animate-fade-up text-xs text-ink-600">{CLASS_DESCRIPTIONS[value as keyof typeof CLASS_DESCRIPTIONS]}</p>}
      {value && (
        <label className="block animate-fade-up space-y-1">
          <span className="label">Reason (required)</span>
          <textarea className="field min-h-[72px]" maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What did you see that the system missed?" />
          {reason.trim().length > 0 && reason.trim().length < MIN_REASON && <span className="text-xs text-ink-500">At least {MIN_REASON} characters.</span>}
        </label>
      )}
      {error && <ErrorNote message={error} />}
      <div className="flex items-center justify-end gap-3">
        {saved && <span className="animate-fade-up text-sm text-success-700">Saved</span>}
        <button className="btn-primary" disabled={!canSubmit}>
          <Save className="h-4 w-4" /> {busy ? 'Saving...' : 'Save change'}
        </button>
      </div>
    </form>
  );
}

const READINESS_OPTIONS: OutreachReadiness[] = ['not_ready', 'exploratory', 'ready'];

function ReadinessForm({ view, onSaved }: { view: FindingView; onSaved: (r: ReadinessDecision) => void }) {
  const [value, setValue] = useState<OutreachReadiness | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');
  const { busy, error, saved, run } = useSubmit();
  const cls = view.assessment.findingClass.value;
  const current = view.assessment.readiness?.readiness ?? null;

  const allowed = (r: OutreachReadiness) =>
    r === 'not_ready' || (r === 'ready' ? cls === 'evidence_backed_opportunity' : cls === 'evidence_backed_opportunity' || cls === 'research_hypothesis');
  const hint: Record<OutreachReadiness, string> = {
    not_ready: 'Keep this out of any outreach.',
    exploratory: allowed('exploratory') ? 'May be raised as an open question, never as a proven problem.' : 'Needs a research hypothesis or evidence-backed class first.',
    ready: allowed('ready') ? 'Only for evidence-backed opportunities you have checked yourself.' : 'Only evidence-backed opportunities can be ready.',
  };
  const canSubmit = !!value && allowed(value) && (value !== 'exploratory' || confirmed) && reason.trim().length >= MIN_REASON && !busy;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value) return;
    void run(async () => {
      onSaved(await submitReadiness({ findingId: view.finding.id, readiness: value, uncertaintyConfirmed: value === 'exploratory' && confirmed, reason }));
      setValue(null);
      setConfirmed(false);
      setReason('');
    });
  };

  return (
    <form onSubmit={submit} className="card space-y-4 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="label flex items-center gap-2"><Megaphone className="h-3.5 w-3.5" /> Outreach readiness</p>
        <ReadinessBadge value={current} />
      </div>
      <p className="text-xs text-ink-500">Separate from maturity and priority. Nothing is ever marked ready automatically.</p>
      <div className="grid gap-2 sm:grid-cols-3">
        {READINESS_OPTIONS.map((r) => (
          <button
            type="button"
            key={r}
            disabled={!allowed(r)}
            onClick={() => setValue(r)}
            className={`rounded-lg border px-3 py-3 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${
              value === r ? 'border-primary-500 bg-primary-50 text-primary-800' : 'border-ink-200 text-ink-700 hover:border-ink-300 hover:bg-ink-50'
            }`}
          >
            <span className="block font-medium">{READINESS_LABELS[r]}</span>
            <span className="mt-1 block text-xs text-ink-500">{hint[r]}</span>
          </button>
        ))}
      </div>
      {value === 'exploratory' && (
        <label className="flex animate-fade-up items-start gap-3 rounded-lg border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-warning-600" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>
            <span className="flex items-center gap-1 font-medium"><ShieldAlert className="h-4 w-4" /> Required confirmation</span>
            Any outreach using this will say plainly that it is unconfirmed, and will not claim proven friction, lost sales or revenue impact.
          </span>
        </label>
      )}
      {value && (
        <label className="block animate-fade-up space-y-1">
          <span className="label">Reason (required)</span>
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
  );
}
