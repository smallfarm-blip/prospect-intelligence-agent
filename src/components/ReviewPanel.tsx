import { useState, type FormEvent } from 'react';
import { CheckCircle2, RotateCcw, Send, XCircle } from 'lucide-react';
import { submitReview } from '@/lib/reviewApi';
import { REJECTION_REASONS, type Decision, type RejectionReason, type Review } from '@/lib/types';
import { DecisionBadge, ErrorNote } from '@/components/ui';
import { formatDate } from '@/lib/format';

const OPTIONS: Array<{ value: Decision; label: string; icon: React.ReactNode; active: string }> = [
  { value: 'approved', label: 'Approve', icon: <CheckCircle2 className="h-4 w-4" />, active: 'border-primary-500 bg-primary-50 text-primary-800' },
  { value: 'rejected', label: 'Reject', icon: <XCircle className="h-4 w-4" />, active: 'border-error-500 bg-error-50 text-error-700' },
  { value: 'revise', label: 'Request revision', icon: <RotateCcw className="h-4 w-4" />, active: 'border-accent-500 bg-accent-50 text-accent-800' },
];

export function ReviewPanel({ findingId, reviews, onSaved }: { findingId: string; reviews: Review[]; onSaved: (r: Review) => void }) {
  const [decision, setDecision] = useState<Decision | null>(null);
  const [reason, setReason] = useState<RejectionReason | ''>('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const needsReason = decision === 'rejected';
  const needsNotes = decision === 'revise' || reason === 'other';
  const canSubmit = !!decision && (!needsReason || !!reason) && (!needsNotes || notes.trim().length > 0) && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!decision) return;
    setBusy(true);
    setError(null);
    try {
      const review = await submitReview({ findingId, decision, rejectionReason: needsReason ? (reason as RejectionReason) : null, notes });
      onSaved(review);
      setDecision(null);
      setReason('');
      setNotes('');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-3">
          {OPTIONS.map((o) => (
            <button
              type="button"
              key={o.value}
              onClick={() => setDecision(o.value)}
              className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-3 text-sm font-medium transition ${
                decision === o.value ? o.active : 'border-ink-200 text-ink-600 hover:border-ink-300 hover:bg-ink-50'
              }`}
            >
              {o.icon}
              {o.label}
            </button>
          ))}
        </div>

        {needsReason && (
          <label className="block animate-fade-up space-y-1">
            <span className="label">Why are you rejecting it?</span>
            <select className="field" value={reason} onChange={(e) => setReason(e.target.value as RejectionReason)} required>
              <option value="">Choose a reason</option>
              {REJECTION_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
        )}

        {decision && (
          <label className="block animate-fade-up space-y-1">
            <span className="label">{needsNotes ? 'Notes (required)' : 'Notes (optional)'}</span>
            <textarea
              className="field min-h-[96px]"
              maxLength={4000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={decision === 'revise' ? 'What should change in the next version?' : 'Anything worth remembering about this decision'}
            />
          </label>
        )}

        {error && <ErrorNote message={error} />}
        <div className="flex items-center justify-end gap-3">
          {saved && <span className="animate-fade-up text-sm text-success-700">Decision saved</span>}
          <button className="btn-primary" disabled={!canSubmit}>
            <Send className="h-4 w-4" /> {busy ? 'Saving...' : 'Save decision'}
          </button>
        </div>
      </form>

      <div className="space-y-2">
        <p className="label">Decision history</p>
        {reviews.length === 0 ? (
          <p className="text-sm text-ink-400">No decisions recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {reviews.map((r) => (
              <li key={r.id} className="rounded-lg border border-ink-200 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <DecisionBadge decision={r.decision} />
                  {r.rejection_reason && <span className="text-xs text-ink-600">{REJECTION_REASONS.find((x) => x.value === r.rejection_reason)?.label}</span>}
                  <span className="ml-auto text-xs text-ink-400">{formatDate(r.created_at)}</span>
                </div>
                {r.notes && <p className="mt-2 whitespace-pre-wrap text-ink-700">{r.notes}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
