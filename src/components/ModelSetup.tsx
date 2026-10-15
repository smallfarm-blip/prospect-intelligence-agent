import { Bot, Images, ShieldCheck } from 'lucide-react';
import type { ModelCall, RoleSettings, RunDetail } from '@/lib/types';
import { humanize, providerName, usd } from '@/lib/format';

interface RoleTotals {
  calls: number;
  input: number;
  output: number;
  reasoning: number | null;
  cost: number;
}

function totals(calls: ModelCall[], reasoning: Map<string, number | null>): RoleTotals {
  const reported = calls.map((c) => reasoning.get(c.id)).filter((r): r is number => typeof r === 'number');
  return {
    calls: calls.length,
    input: calls.reduce((s, c) => s + (c.input_tokens ?? 0), 0),
    output: calls.reduce((s, c) => s + (c.output_tokens ?? 0), 0),
    reasoning: reported.length ? reported.reduce((s, r) => s + r, 0) : null,
    cost: calls.reduce((s, c) => s + c.estimated_cost_usd, 0),
  };
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right font-medium text-ink-800 tabular-nums">{value}</dd>
    </div>
  );
}

function RoleCard({ title, icon, provider, model, settings, t, note }: { title: string; icon: React.ReactNode; provider: string; model: string; settings?: RoleSettings; t: RoleTotals; note?: string }) {
  return (
    <div className="rounded-lg border border-ink-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="label flex items-center gap-1">{icon}{title}</p>
        <span className="rounded-full bg-secondary-50 px-2 py-0.5 text-xs font-medium text-secondary-700">{providerName(provider)}</span>
      </div>
      <p className="mt-2 font-mono text-sm text-ink-900">{model}</p>
      <dl className="mt-3 divide-y divide-ink-100 text-sm">
        {settings && <Row label="Price per million tokens" value={`${usd(settings.pricing.inputUsdPerMTok, 2)} in / ${usd(settings.pricing.outputUsdPerMTok, 2)} out`} />}
        {settings && <Row label="Output limit" value={`${settings.maxOutputTokens.toLocaleString()} tokens`} />}
        {settings?.imageDetail && <Row label="Image detail" value={humanize(settings.imageDetail)} />}
        {settings?.reasoningEffort && <Row label="Reasoning effort" value={humanize(settings.reasoningEffort)} />}
        {settings?.serviceTier && <Row label="Processing tier" value={humanize(settings.serviceTier)} />}
        <Row label="Calls" value={t.calls} />
        <Row label="Tokens in / out" value={`${t.input.toLocaleString()} / ${t.output.toLocaleString()}`} />
        <Row label="Reasoning tokens" value={t.reasoning != null ? `${t.reasoning.toLocaleString()} (within output)` : 'Not reported'} />
        <Row label="Estimated cost" value={usd(t.cost)} />
      </dl>
      {note && <p className="mt-2 text-xs text-ink-500">{note}</p>}
    </div>
  );
}

export function ModelSetup({ detail }: { detail: RunDetail }) {
  const { run, calls } = detail;
  const config = run.config ?? {};
  const reasoning = new Map((config.usage?.calls ?? []).map((u) => [u.call_id, u.reasoning_tokens]));
  const analystCalls = calls.filter((c) => c.role !== 'verifier');
  const verifierCalls = calls.filter((c) => c.role === 'verifier');
  const manifest = run.evidence_manifest ?? {};
  const images = manifest.images ?? [];
  const imageTokens = images.reduce((s, i) => s + (i.estimatedTokens ?? 0), 0);
  const unanalysed = manifest.unanalysed?.length ?? 0;
  const skipped = manifest.skipped?.length ?? 0;

  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <RoleCard
        title="Analyst"
        icon={<Bot className="h-3.5 w-3.5" />}
        provider={run.analyst_provider}
        model={run.analyst_model}
        settings={config.analyst}
        t={totals(analystCalls, reasoning)}
        note={analystCalls.some((c) => c.role === 'revision') ? 'Includes revision calls, which use the analyst model.' : undefined}
      />
      <RoleCard title="Verifier" icon={<ShieldCheck className="h-3.5 w-3.5" />} provider={run.verifier_provider} model={run.verifier_model} settings={config.verifier} t={totals(verifierCalls, reasoning)} />
      <div className="rounded-lg border border-ink-200 bg-white p-4">
        <p className="label flex items-center gap-1"><Images className="h-3.5 w-3.5" />Evidence coverage</p>
        <dl className="mt-3 divide-y divide-ink-100 text-sm">
          <Row label="Pages analysed" value={manifest.pages?.length ?? '-'} />
          <Row label="Screenshot regions sent" value={images.length} />
          <Row label="Approx. image tokens" value={imageTokens ? imageTokens.toLocaleString() : '-'} />
          <Row label="Regions left unanalysed" value={unanalysed} />
          <Row label="Pages skipped" value={skipped} />
          {config.images && <Row label="Image preparation" value={`${config.images.maxLongEdge}px max, JPEG ${config.images.jpegQuality}`} />}
        </dl>
        {(unanalysed > 0 || skipped > 0) && <p className="mt-2 text-xs text-warning-700">Some captured evidence was not sent to the model. See evidence warnings below.</p>}
      </div>
    </div>
  );
}
