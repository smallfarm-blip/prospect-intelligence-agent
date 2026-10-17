import { AlertTriangle, CheckCircle2, Info, Lock, PencilLine, XCircle } from 'lucide-react';
import type { OpportunityAssessment, Verification } from '@/lib/types';
import { Badge, ClassBadge, EvidenceBadge, PriorityBadge, VerificationBadge } from '@/components/ui';
import { formatDate, humanize } from '@/lib/format';

const VERDICT_TONE: Record<string, 'success' | 'warning' | 'error' | 'neutral'> = {
  demonstrated: 'success',
  appropriately_framed: 'success',
  partially_demonstrated: 'warning',
  overstated: 'warning',
  not_demonstrated: 'error',
  contradicted: 'error',
};

function Judgement({ ok, label, reason }: { ok: boolean; label: string; reason: string }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-ink-200 p-3 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-600" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-error-600" />}
      <div>
        <p className="font-medium text-ink-800">{label}</p>
        <p className="text-ink-600">{reason}</p>
      </div>
    </div>
  );
}

function OpportunityQuality({ o, assignedClass, assignedPriority }: { o: OpportunityAssessment; assignedClass: Verification['assigned_class']; assignedPriority: Verification['assigned_priority'] }) {
  return (
    <section className="space-y-3">
      <p className="label">Opportunity quality (judged separately from the evidence)</p>
      <div className="space-y-3 rounded-lg border border-ink-200 bg-white p-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-500">System assigned</span>
          <ClassBadge value={assignedClass} />
          <PriorityBadge value={assignedPriority} />
        </div>
        <p className="text-ink-700">{o.reason}</p>
        <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          <div><dt className="inline text-ink-500">Decision importance: </dt><dd className="inline font-medium text-ink-800">{humanize(o.decision_importance)}</dd></div>
          <div><dt className="inline text-ink-500">Commercial relevance: </dt><dd className="inline font-medium text-ink-800">{humanize(o.commercial_relevance)}</dd></div>
          <div><dt className="inline text-ink-500">Route to revenue credible: </dt><dd className="inline font-medium text-ink-800">{o.rpv_pathway_credible ? 'Yes' : 'No'}</dd></div>
          <div><dt className="inline text-ink-500">Existing site support considered: </dt><dd className="inline font-medium text-ink-800">{o.existing_support_considered ? 'Yes' : 'No'}</dd></div>
          <div><dt className="inline text-ink-500">Recommends a fix too early: </dt><dd className="inline font-medium text-ink-800">{o.premature_recommendation ? 'Yes' : 'No'}</dd></div>
        </dl>
        <div>
          <p className="label">Friction or simply a complex decision?</p>
          <p className="mt-1 text-ink-700">{o.friction_vs_complexity}</p>
        </div>
        {o.missed_existing_support.length > 0 && (
          <div>
            <p className="label">Site support the analyst missed</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-700">{o.missed_existing_support.map((s, n) => <li key={n}>{s}</li>)}</ul>
          </div>
        )}
        {o.critical_gaps.length > 0 && (
          <div>
            <p className="label">Critical gaps</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-ink-700">{o.critical_gaps.map((s, n) => <li key={n}>{s}</li>)}</ul>
          </div>
        )}
        {o.assignment_notes && o.assignment_notes.length > 0 && (
          <div className="rounded-md bg-ink-50 p-3">
            <p className="label">Why the system lowered the class</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-ink-700">{o.assignment_notes.map((s, n) => <li key={n}>{s}</li>)}</ul>
          </div>
        )}
      </div>
    </section>
  );
}

export function VerificationPanel({ verification }: { verification: Verification | null }) {
  if (!verification) {
    return (
      <div className="flex items-start gap-3 rounded-lg border border-ink-200 bg-ink-50 p-4 text-sm text-ink-600">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        This finding was not verified. The verifier call failed or was skipped; check the model call log for this run.
      </div>
    );
  }
  const v = verification;
  const mv = v.model_verdict;
  const separated = v.evidence_status !== null;
  return (
    <div className="space-y-6">
      <p className="flex items-center gap-2 text-xs text-ink-500">
        <Lock className="h-3.5 w-3.5" /> Recorded results. Reviewers cannot change them; use the Assessment tab to record a different view.
      </p>
      <div className="space-y-2 rounded-lg border border-ink-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2">
          {separated ? <EvidenceBadge status={v.evidence_status} /> : <VerificationBadge status={v.status} />}
          {separated && v.status !== v.evidence_status && <span className="text-xs text-ink-500">overall: {humanize(v.status)}</span>}
          <span className="text-xs text-ink-500">{v.verifier_model ?? 'Automatic checks only'} / {formatDate(v.created_at)}</span>
        </div>
        <p className="text-sm text-ink-700">{v.reason}</p>
      </div>

      {v.opportunity_assessment && (
        <OpportunityQuality o={v.opportunity_assessment} assignedClass={v.assigned_class} assignedPriority={v.assigned_priority} />
      )}

      <div className="space-y-2">
        <p className="label">{separated ? 'Evidence verification: automatic checks' : 'Automatic checks'}</p>
        <ul className="divide-y divide-ink-100 rounded-lg border border-ink-200">
          {v.automatic_checks.map((c) => (
            <li key={c.check} className="flex items-start gap-3 p-3 text-sm">
              {c.passed ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success-600" />
              ) : c.severity === 'blocker' ? (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-error-600" />
              ) : c.severity === 'revision' ? (
                <PencilLine className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" />
              ) : (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-600" />
              )}
              <div className="min-w-0">
                <p className="font-medium text-ink-800">
                  {humanize(c.check)} {!c.passed && <span className="text-xs font-normal text-ink-500">({c.severity === 'revision' ? 'needs revision' : c.severity})</span>}
                </p>
                {c.detail && <p className="break-words text-ink-600">{c.detail}</p>}
              </div>
            </li>
          ))}
        </ul>
      </div>

      {v.claim_checks.length > 0 && (
        <div className="space-y-2">
          <p className="label">Claim by claim</p>
          <ul className="space-y-2">
            {v.claim_checks.map((cc) => (
              <li key={cc.claim_id} className="rounded-lg border border-ink-200 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-ink-500">{cc.claim_id}</span>
                  {cc.claim && <Badge>{humanize(cc.claim.type)}</Badge>}
                  <Badge tone={VERDICT_TONE[cc.verdict] ?? 'neutral'}>{humanize(cc.verdict)}</Badge>
                </div>
                {cc.claim && <p className="mt-2 text-ink-800">{cc.claim.text}</p>}
                <p className="mt-1 text-ink-600">{cc.reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {mv && (
        <div className="space-y-2">
          <p className="label">Verifier judgements</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Judgement ok={mv.decision_problem.meaningful} label="Meaningful visitor decision problem" reason={mv.decision_problem.reason} />
            <Judgement ok={!mv.generic_check.generic} label="Specific to this site" reason={mv.generic_check.reason} />
            <Judgement ok={mv.page_and_state_check.correct} label="Right page and capture state" reason={mv.page_and_state_check.reason} />
            <Judgement
              ok={mv.metadata_consistency.consistent}
              label="Screenshots match recorded pop-up data"
              reason={mv.metadata_consistency.contradictions.length ? mv.metadata_consistency.contradictions.join(' ') : 'No contradictions found.'}
            />
          </div>
        </div>
      )}
    </div>
  );
}
