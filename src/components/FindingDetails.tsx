import type { ReactNode } from 'react';
import { Eye, Lightbulb, LineChart, TrendingUp } from 'lucide-react';
import type { FindingContent } from '@/lib/types';
import { humanize } from '@/lib/format';

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

export function FindingDetails({ content: c }: { content: FindingContent }) {
  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Visitor task">{c.visitor_task}</Field>
        <Field label="Entry context">{c.entry_context}</Field>
        <Field label="Decision moment">{c.decision_moment}</Field>
      </div>

      <Section icon={<Eye className="h-4 w-4" />} title="Observed facts" tone="text-secondary-700">
        {c.observed_facts.map((f) => (
          <div key={f.fact_id} className="rounded-lg bg-secondary-50/60 p-3 text-sm">
            <div className="flex items-start gap-2">
              <span className="font-mono text-xs font-medium text-secondary-700">{f.fact_id}</span>
              <p className="text-ink-800">{f.statement}</p>
            </div>
            {f.text_excerpt && <blockquote className="mt-2 border-l-2 border-secondary-300 pl-3 font-serif italic text-ink-600">"{f.text_excerpt}"</blockquote>}
            <p className="mt-2 font-mono text-xs text-ink-500">Cites {f.evidence_refs.join(', ')}{f.region ? ` / region on ${f.region.image_ref}` : ''}</p>
          </div>
        ))}
      </Section>

      <Section icon={<Lightbulb className="h-4 w-4" />} title="Hypothesis (inference, not observation)" tone="text-accent-700">
        <Field label="Hypothesis">{c.hypothesis}</Field>
        <Field label="Behavioural question">{c.behavioral_question}</Field>
        <Field label="Expected behaviour shift">{c.expected_behavior_shift}</Field>
        <Field label="Alternative explanations"><List items={c.alternative_explanations} /></Field>
        <Field label="Unknowns"><List items={c.unknowns} /></Field>
        <Field label="Simpler alternative considered">{c.simpler_alternative_considered}</Field>
      </Section>

      <Section icon={<TrendingUp className="h-4 w-4" />} title="Potential commercial relevance" tone="text-primary-700">
        <Field label="Why it may matter">{c.commercial_relevance}</Field>
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
