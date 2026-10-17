import type { ReactNode } from 'react';
import { AlertOctagon, Eye, Footprints, Lightbulb, LineChart, ListChecks, Route, TrendingUp } from 'lucide-react';
import type { CriticalUnknown, FindingContent } from '@/lib/types';
import { CLASS_LABELS, PRIORITY_LABELS } from '@/lib/assessment';
import { humanize, QUOTE_KIND_LABELS } from '@/lib/format';

function Section({ icon, title, tone, children }: { icon: ReactNode; title: string; tone: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h4 className={`flex items-center gap-2 text-sm font-semibold ${tone}`}>{icon}{title}</h4>
      <div className="space-y-3 border-l-2 border-ink-100 pl-4">{children}</div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="label">{label}</p>
      <div className="mt-1 text-sm text-ink-700">{children}</div>
    </div>
  );
}

function List({ items }: { items: string[] }) {
  if (!items.length) return <span className="text-ink-400">None listed</span>;
  return <ul className="list-disc space-y-1 pl-5">{items.map((i, n) => <li key={n}>{i}</li>)}</ul>;
}

function Refs({ ids }: { ids: string[] }) {
  return <span className="font-mono text-xs text-ink-500">{ids.length ? `based on ${ids.join(', ')}` : 'no facts linked'}</span>;
}

const SEVERITY: Record<CriticalUnknown['severity'], { label: string; style: string }> = {
  could_invalidate: { label: 'Could invalidate', style: 'border-error-200 bg-error-50 text-error-700' },
  affects_priority: { label: 'Affects priority', style: 'border-warning-200 bg-warning-50 text-warning-700' },
  minor: { label: 'Minor', style: 'border-ink-200 bg-white text-ink-600' },
};

function CriticalUnknowns({ items }: { items: CriticalUnknown[] }) {
  const blocking = items.filter((u) => u.severity === 'could_invalidate').length;
  return (
    <Section icon={<AlertOctagon className="h-4 w-4" />} title="Critical unknowns" tone="text-error-700">
      {blocking > 0 && (
        <p className="rounded-lg bg-error-50 p-3 text-sm text-error-700">
          {blocking === 1 ? 'One open question' : `${blocking} open questions`} could overturn this finding. Resolve before treating it as established.
        </p>
      )}
      {items.length === 0 && <span className="text-sm text-ink-400">None listed</span>}
      {items.map((u, n) => (
        <div key={n} className={`rounded-lg border p-3 text-sm ${SEVERITY[u.severity].style}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide">{SEVERITY[u.severity].label}</span>
            <span className="text-xs opacity-80">{humanize(u.resolution_effort)} effort to resolve</span>
          </div>
          <p className="mt-1 font-medium text-ink-800">{u.unknown}</p>
          <p className="mt-1 text-ink-700">{u.why_it_matters}</p>
          <p className="mt-2 text-xs text-ink-600">How to resolve: {u.how_to_resolve} ({u.resolution_source})</p>
        </div>
      ))}
    </Section>
  );
}

export function FindingDetails({ content: c }: { content: FindingContent }) {
  const p = c.investigation_priority;
  return (
    <div className="space-y-8">
      {(c.finding_class || p) && (
        <div className="grid gap-4 rounded-xl border border-ink-200 bg-white p-4 sm:grid-cols-2">
          {c.finding_class && (
            <Field label={`Analyst proposed: ${CLASS_LABELS[c.finding_class]}`}>
              {c.class_rationale}
              {c.problem_type && (
                <p className="mt-2 text-xs text-ink-500">
                  Problem type: <span className="font-medium text-ink-700">{humanize(c.problem_type)}</span>. {c.problem_type_rationale}
                </p>
              )}
            </Field>
          )}
          {p && (
            <Field label={`Analyst proposed: ${PRIORITY_LABELS[p.level]}`}>
              <dl className="space-y-1 text-xs">
                {([['Commercial relevance', p.commercial_relevance], ['Decision importance', p.decision_importance], ['Hypothesis strength', p.hypothesis_strength], ['Effort to resolve unknowns', p.effort_to_resolve_unknowns]] as const).map(([k, v]) => (
                  <div key={k}><dt className="inline font-medium text-ink-700">{k}: </dt><dd className="inline text-ink-600">{v}</dd></div>
                ))}
              </dl>
            </Field>
          )}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Visitor task">{c.visitor_task}</Field>
        <Field label="Entry context">{c.entry_context}</Field>
        <Field label="Decision moment">{c.decision_moment}</Field>
      </div>

      {c.critical_unknowns && <CriticalUnknowns items={c.critical_unknowns} />}

      {c.journey && (
        <Section icon={<Route className="h-4 w-4" />} title="Cross-page journey" tone="text-secondary-700">
          <ol className="space-y-2">
            {c.journey.steps.map((s, n) => (
              <li key={n} className="flex items-start gap-3 text-sm">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary-100 font-mono text-xs text-secondary-700">{s.page_ref}</span>
                <span className="text-ink-700">{s.role_in_journey} <Refs ids={s.fact_ids} /></span>
              </li>
            ))}
          </ol>
          <Field label="How the steps connect">{c.journey.coherence}</Field>
        </Section>
      )}

      <Section icon={<Eye className="h-4 w-4" />} title="Observed facts" tone="text-secondary-700">
        {c.observed_facts.map((f) => (
          <div key={f.fact_id} className="rounded-lg bg-secondary-50/60 p-3 text-sm">
            <div className="flex items-start gap-2">
              <span className="font-mono text-xs font-medium text-secondary-700">{f.fact_id}</span>
              <p className="flex-1 text-ink-800">{f.statement}</p>
              {(f.page_ref || f.device) && (
                <span className="shrink-0 rounded bg-white px-1.5 py-0.5 font-mono text-[11px] text-ink-600">
                  {[f.page_ref, f.device].filter(Boolean).join(' / ')}
                </span>
              )}
            </div>
            {f.text_excerpt && (
              <div className="mt-2">
                <blockquote className="border-l-2 border-secondary-300 pl-3 font-serif italic text-ink-600">"{f.text_excerpt}"</blockquote>
                {f.quote_kind && <p className="mt-1 pl-3 text-xs text-ink-500">{QUOTE_KIND_LABELS[f.quote_kind]}</p>}
              </div>
            )}
            <p className="mt-2 font-mono text-xs text-ink-500">Cites {f.evidence_refs.join(', ')}{f.region ? ` / region on ${f.region.image_ref}` : ''}</p>
          </div>
        ))}
      </Section>

      {c.existing_site_support && (
        <Section icon={<ListChecks className="h-4 w-4" />} title="What the site already offers" tone="text-success-700">
          {c.existing_site_support.length === 0 && <span className="text-sm text-ink-400">None identified</span>}
          {c.existing_site_support.map((s, n) => (
            <div key={n} className="text-sm">
              <p className="text-ink-800">{s.support} <Refs ids={s.fact_ids} /></p>
              <p className="mt-1 text-ink-600">{s.how_it_affects_hypothesis}</p>
            </div>
          ))}
        </Section>
      )}

      {c.behavioral_inferences && (
        <Section icon={<Footprints className="h-4 w-4" />} title="Informed inferences (reasoned, not observed)" tone="text-accent-700">
          {c.behavioral_inferences.length === 0 && <span className="text-sm text-ink-400">None made</span>}
          {c.behavioral_inferences.map((i) => (
            <p key={i.inference_id} className="text-sm text-ink-700">
              <span className="mr-2 font-mono text-xs font-medium text-accent-700">{i.inference_id}</span>
              {i.statement} <Refs ids={i.basis_fact_ids} />
            </p>
          ))}
        </Section>
      )}

      <Section icon={<Lightbulb className="h-4 w-4" />} title="Hypothesis (inference, not observation)" tone="text-accent-700">
        <Field label="Hypothesis">{c.hypothesis}</Field>
        <Field label="Behavioural question">{c.behavioral_question}</Field>
        <Field label="Expected behaviour shift">{c.expected_behavior_shift}</Field>
        <Field label="Alternative explanations"><List items={c.alternative_explanations} /></Field>
        {c.unknowns && <Field label="Unknowns"><List items={c.unknowns} /></Field>}
        <Field label="Simpler alternative considered">{c.simpler_alternative_considered}</Field>
      </Section>

      <Section icon={<TrendingUp className="h-4 w-4" />} title="Potential commercial relevance" tone="text-primary-700">
        <Field label="Why it may matter">{c.commercial_relevance}</Field>
        {c.rpv_pathway && (
          <Field label="Possible route to revenue per visitor (not measured)">
            <div className="flex flex-wrap gap-1.5">
              {c.rpv_pathway.levers.map((l) => (
                <span key={l} className="rounded-full bg-primary-50 px-2 py-0.5 text-xs font-medium text-primary-800">{humanize(l)}</span>
              ))}
            </div>
            <p className="mt-2">{c.rpv_pathway.mechanism}</p>
            <p className="mt-1 text-xs text-ink-500">Would be confirmed by: {c.rpv_pathway.confirming_evidence}</p>
          </Field>
        )}
        <Field label="Possible next step">{c.possible_next_step}</Field>
        <Field label={`Confidence: ${humanize(c.confidence)} / evidence ${c.evidence_quality}`}>{c.confidence_explanation}</Field>
      </Section>

      <Section icon={<LineChart className="h-4 w-4" />} title="Validation and measurement (nothing here was measured)" tone="text-ink-700">
        <Field label="Primary KPI">{c.measurement_plan.primary_kpi}</Field>
        <Field label="Secondary indicators"><List items={c.measurement_plan.secondary_indicators} /></Field>
        <Field label="Segment or context">{c.measurement_plan.segment_or_context}</Field>
        <Field label="Intent signals to examine"><List items={c.intent_signals_to_examine} /></Field>
        <Field label="Data needed to validate"><List items={c.validation_data_needed} /></Field>
      </Section>
    </div>
  );
}
