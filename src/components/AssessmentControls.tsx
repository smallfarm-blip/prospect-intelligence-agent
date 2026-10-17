import { useState, type FormEvent, type ReactNode } from 'react';
import { Lock, Save } from 'lucide-react';
import { submitOverride } from '@/lib/reviewApi';
import type { FindingView } from '@/lib/findingView';
import type { AssessmentField, AssessmentOverride, ReadinessDecision } from '@/lib/types';
import { CLASS_DESCRIPTIONS, CLASS_LABELS, CLASSES, PRIORITIES, PRIORITY_LABELS, SOURCE_LABELS, fieldValueLabel, type Effective } from '@/lib/assessment';
import { ClassBadge, ErrorNote, PriorityBadge } from '@/components/ui';
import { OutreachDecision } from '@/components/OutreachDecision';
import { formatDate } from '@/lib/format';

const MIN_REASON = 10;

interface Props {
  view: FindingView;
  onOverrideSaved: (o: AssessmentOverride) => void;
  onReadinessSaved: (r: ReadinessDecision) => void;
}

export function AssessmentControls({ view, onOverrideSaved, onReadinessSaved }: Props) {
  const { assessment, overrides, finding } = view;
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

      <OutreachDecision view={view} onSaved={onReadinessSaved} />
    </div>
  );
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const isClass = field === 'finding_class';
  const options = isClass ? CLASSES.map((c) => ({ value: c, label: CLASS_LABELS[c] })) : PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
  const canSubmit = !!value && value !== current.value && reason.trim().length >= MIN_REASON && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(await submitOverride({ findingId, field, newValue: value, reason }));
      setValue('');
      setReason('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="label">{title}</p>
        {badge}
      </div>
      <p className="text-xs text-ink-500">
        {current.source ? `Currently ${SOURCE_LABELS[current.source]}.` : 'Not set for this finding.'} System value: {fieldValueLabel(field, current.system)}.
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
