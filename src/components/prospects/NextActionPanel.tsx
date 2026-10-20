import { useState } from 'react';
import { Building2, CircleSlash, Compass, HelpCircle, ListChecks, PencilLine, SearchCheck, UserCheck } from 'lucide-react';
import { submitProspectOverride } from '@/lib/prospectApi';
import { NEXT_ACTION_KEYS, type NextActionKey } from '@/lib/prospectTypes';
import { nextActionOverrideProblem, reasonProblem, type ProspectView } from '@/lib/prospectView';
import { formatDate } from '@/lib/format';
import { Badge, ErrorNote } from '@/components/ui';
import { Modal } from '@/components/prospects/Modal';
import { ReasonField } from '@/components/prospects/ReviewActions';
import { NEXT_ACTION_META } from '@/components/prospects/labels';

const ICONS: Record<NextActionKey, typeof Compass> = {
  verify_commercial_capacity: Building2,
  validate_business_need: SearchCheck,
  confirm_decision_maker: UserCheck,
  investigate_website: Compass,
  defer: CircleSlash,
};

export function NextActionBadge({ actionKey, overridden }: { actionKey: NextActionKey; overridden?: boolean }) {
  const Icon = ICONS[actionKey];
  return (
    <Badge tone={NEXT_ACTION_META[actionKey].tone} icon={<Icon className="h-3.5 w-3.5" />}>
      {NEXT_ACTION_META[actionKey].label}
      {overridden && <span className="font-normal opacity-75">· reviewer</span>}
    </Badge>
  );
}

export function NextActionPanel({ view, onChanged }: { view: ProspectView; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const na = view.nextAction;
  if (!view.score) return null;
  const system = na?.system ?? null;
  const overridden = !!na?.override && na.override.new_value !== system?.key;

  return (
    <section className="card overflow-hidden border-ink-900/10">
      <div className="flex flex-wrap items-center justify-between gap-3 bg-ink-900 px-5 py-4 text-white">
        <div className="flex items-center gap-2">
          <ListChecks className="h-4 w-4 text-accent-200" />
          <h2 className="text-xs font-medium uppercase tracking-wider text-accent-100">Primary next action</h2>
        </div>
        <div className="flex items-center gap-2">
          {na && <NextActionBadge actionKey={na.key} overridden={!!na.override} />}
          <button className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-200 transition hover:bg-white/10 hover:text-white disabled:opacity-40" onClick={() => setEditing(true)} disabled={!na}>
            <PencilLine className="h-3.5 w-3.5" /> Change
          </button>
        </div>
      </div>

      {!na ? (
        <p className="p-5 text-sm text-ink-500">This score predates next-action recommendations. Rescoring the company will add one.</p>
      ) : (
        <div className="space-y-4 p-5">
          {na.override && (
            <div className="rounded-lg border border-secondary-200 bg-secondary-50 px-4 py-3 text-sm text-ink-700">
              <span className="font-medium text-secondary-800">Reviewer choice on {formatDate(na.override.created_at)}: </span>
              {na.override.reason}
              {system && overridden && <span className="mt-1 block text-xs text-ink-500">The evidence-based recommendation was {NEXT_ACTION_META[system.key].label}; it is shown below for reference.</span>}
            </div>
          )}
          {system && (
            <>
              <p className="text-sm leading-relaxed text-ink-800">{system.explanation}</p>
              <p className="text-sm text-ink-600"><span className="font-medium text-ink-800">How: </span>{system.step}</p>
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <div className="label">Supporting evidence</div>
                  {system.evidence.length === 0 ? <p className="mt-1 text-sm text-ink-500">No supporting evidence recorded.</p> : (
                    <ul className="ml-4 mt-1 list-disc space-y-0.5 text-sm text-ink-700">{system.evidence.map((e) => <li key={e}>{e}</li>)}</ul>
                  )}
                </div>
                <div className="rounded-lg bg-warning-50 px-4 py-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-warning-700">
                    <HelpCircle className="h-3.5 w-3.5" /> Most important unknown
                  </div>
                  <p className="mt-1 text-sm text-ink-800">{system.keyUnknown}</p>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {editing && na && <NextActionDialog view={view} current={na.key} onClose={() => setEditing(false)} onSaved={onChanged} />}
    </section>
  );
}

function NextActionDialog({ view, current, onClose, onSaved }: { view: ProspectView; current: NextActionKey; onClose: () => void; onSaved: () => Promise<void> }) {
  const [choice, setChoice] = useState<NextActionKey>(current);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const valueProblem = nextActionOverrideProblem(choice, current);
  const problem = valueProblem ?? reasonProblem(reason);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await submitProspectOverride({ companyId: view.id, field: 'next_action', newValue: choice, reason });
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal title={`Change next action: ${view.name}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid gap-2">
          {NEXT_ACTION_KEYS.map((k) => {
            const Icon = ICONS[k];
            return (
              <button key={k} onClick={() => setChoice(k)} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition ${choice === k ? 'border-primary-600 bg-primary-50 text-primary-800' : 'border-ink-200 text-ink-700 hover:bg-ink-50'}`}>
                <Icon className="h-4 w-4" /> {NEXT_ACTION_META[k].label}
                {k === current && <span className="ml-auto text-xs font-normal text-ink-400">current</span>}
              </button>
            );
          })}
        </div>
        <ReasonField value={reason} onChange={setReason} prompt="Why is this the better next question to answer?" />
        <p className="text-xs text-ink-500">The evidence-based recommendation is kept alongside your choice, and both stay in the history.</p>
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
