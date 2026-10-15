import { useState } from 'react';
import { AlertTriangle, ChevronDown, Coins, Cpu, FileWarning, Layers } from 'lucide-react';
import type { RunDetail } from '@/lib/types';
import { Badge } from '@/components/ui';
import { formatDate, humanize, providerName, usd } from '@/lib/format';
import { ModelSetup } from '@/components/ModelSetup';

const CALL_TONE = { succeeded: 'success', invalid_output: 'warning', failed: 'error', refused_budget: 'warning' } as const;

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-4">
      <p className="label flex items-center gap-1">{icon}{label}</p>
      <p className="mt-2 text-lg font-semibold text-ink-900">{value}</p>
      {sub && <p className="text-xs text-ink-500">{sub}</p>}
    </div>
  );
}

function Notes({ title, tone, items }: { title: string; tone: 'warning' | 'error' | 'neutral'; items: string[] }) {
  if (!items.length) return null;
  const color = tone === 'error' ? 'border-error-200 bg-error-50 text-error-700' : tone === 'warning' ? 'border-warning-200 bg-warning-50 text-warning-700' : 'border-ink-200 bg-ink-50 text-ink-700';
  return (
    <div className={`rounded-lg border p-4 text-sm ${color}`}>
      <p className="font-medium">{title}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">{items.map((i, n) => <li key={n}>{i}</li>)}</ul>
    </div>
  );
}

export function RunOverview({ detail }: { detail: RunDetail }) {
  const { run, calls } = detail;
  const [showCalls, setShowCalls] = useState(false);
  const pct = run.budget_usd ? Math.min(100, (run.estimated_cost_usd / run.budget_usd) * 100) : 0;
  const usage = run.config?.usage;
  const callUsage = new Map((usage?.calls ?? []).map((u) => [u.call_id, u]));

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="label">Analysis run {run.id.slice(0, 8)} / evidence run {run.research_run_id.slice(0, 8)}</p>
          <h1 className="mt-1 font-serif text-3xl font-semibold text-ink-900">{run.companies?.name ?? 'Analysis'}</h1>
          <p className="mt-1 text-sm text-ink-500">
            {formatDate(run.started_at)} to {formatDate(run.ended_at)}
          </p>
        </div>
        <Badge tone={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : 'warning'}>{humanize(run.status)}</Badge>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-ink-200 bg-white p-4">
          <p className="label flex items-center gap-1"><Coins className="h-3.5 w-3.5" />Estimated cost</p>
          <p className="mt-2 text-lg font-semibold text-ink-900">{usd(run.estimated_cost_usd)}</p>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100">
            <div className={`h-full rounded-full transition-all ${pct > 90 ? 'bg-warning-500' : 'bg-primary-500'}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-1 text-xs text-ink-500">of {usd(run.budget_usd, 2)} budget</p>
          <p className="mt-2 text-xs text-ink-500">
            {run.billed_cost_usd != null ? `Billed: ${usd(run.billed_cost_usd)}` : 'Estimate from provider-reported tokens at configured prices. Not a bill.'}
            {usage && usage.uncertain_billing_reserved_usd > 0 && ` Includes ${usd(usage.uncertain_billing_reserved_usd)} reserved for calls with unknown billing.`}
          </p>
        </div>
        <Stat
          icon={<Layers className="h-3.5 w-3.5" />}
          label="Tokens"
          value={(run.input_tokens + run.output_tokens).toLocaleString()}
          sub={`${run.input_tokens.toLocaleString()} in / ${run.output_tokens.toLocaleString()} out${usage?.reasoning_tokens ? ` (${usage.reasoning_tokens.toLocaleString()} reasoning)` : ''}`}
        />
        <Stat
          icon={<Cpu className="h-3.5 w-3.5" />}
          label="Model calls"
          value={String(run.model_call_count)}
          sub={`${providerName(run.analyst_provider)} analyst / ${providerName(run.verifier_provider)} verifier`}
        />
        <Stat icon={<FileWarning className="h-3.5 w-3.5" />} label="Findings" value={String(run.finding_count)} sub={Object.values(run.prompt_versions ?? {}).join(', ')} />
      </div>

      <ModelSetup detail={detail} />

      {run.assessment_summary && (
        <div className="card p-5">
          <p className="label">Analyst assessment</p>
          <p className="mt-2 text-sm text-ink-700">{run.assessment_summary}</p>
        </div>
      )}
      {run.no_findings_reason && <Notes title="Why there are no findings" tone="neutral" items={[run.no_findings_reason]} />}
      <Notes title="Errors" tone="error" items={run.errors ?? []} />
      <Notes title="Evidence warnings" tone="warning" items={run.evidence_warnings ?? []} />
      <Notes title="Evidence limitations noted by the analyst" tone="neutral" items={run.evidence_limitations ?? []} />

      <div className="card overflow-hidden">
        <button className="flex w-full items-center justify-between px-5 py-3 text-sm font-medium text-ink-700 hover:bg-ink-50" onClick={() => setShowCalls(!showCalls)}>
          <span>Model call log ({calls.length})</span>
          <ChevronDown className={`h-4 w-4 transition ${showCalls ? 'rotate-180' : ''}`} />
        </button>
        {showCalls && (
          <div className="overflow-x-auto border-t border-ink-200">
            <table className="w-full text-left text-sm">
              <thead className="bg-ink-50 text-xs uppercase tracking-wider text-ink-500">
                <tr>
                  {['Role', 'Model', 'Finding', 'Status', 'Pre-call count', 'Tokens in / out', 'Reasoning', 'Est. cost', 'Worst case', 'Time'].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100">
                {calls.map((c) => (
                  <tr key={c.id} className="align-top">
                    <td className="px-4 py-2 capitalize">{c.role}</td>
                    <td className="px-4 py-2 text-xs">
                      <span className="block text-ink-500">{providerName(c.provider)}</span>
                      <span className="font-mono">{c.model}</span>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{c.finding_ref ?? '-'}</td>
                    <td className="px-4 py-2">
                      <Badge tone={CALL_TONE[c.status]}>{humanize(c.status)}</Badge>
                      {(c.error || c.validation_errors?.length > 0) && (
                        <p className="mt-1 flex max-w-xs items-start gap-1 text-xs text-ink-500">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          {c.error ?? c.validation_errors.slice(0, 3).join('; ')}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2 tabular-nums text-ink-500">
                      {c.counted_input_tokens ?? '-'}
                      {callUsage.get(c.id)?.count_method === 'estimate' && <span className="block text-xs">local estimate</span>}
                    </td>
                    <td className="px-4 py-2 tabular-nums">{c.input_tokens ?? '-'} / {c.output_tokens ?? '-'}</td>
                    <td className="px-4 py-2 tabular-nums text-ink-500">{callUsage.get(c.id)?.reasoning_tokens ?? '-'}</td>
                    <td className="px-4 py-2 tabular-nums">{usd(c.estimated_cost_usd)}</td>
                    <td className="px-4 py-2 tabular-nums text-ink-500">{usd(c.worst_case_cost_usd)}</td>
                    <td className="px-4 py-2 tabular-nums text-ink-500">{c.latency_ms != null ? `${(c.latency_ms / 1000).toFixed(1)}s` : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
