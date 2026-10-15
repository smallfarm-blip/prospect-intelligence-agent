import { useMemo } from 'react';
import { Building2, ChevronRight } from 'lucide-react';
import type { AnalysisRun } from '@/lib/types';
import { Badge } from '@/components/ui';
import { formatDate, providerName, usd } from '@/lib/format';

const STATUS_TONE = { completed: 'success', running: 'secondary', stopped_budget: 'warning', failed: 'error' } as const;

interface Props {
  runs: AnalysisRun[];
  companyId: string | null;
  runId: string | null;
  onCompany: (id: string) => void;
  onRun: (id: string) => void;
}

export function RunSidebar({ runs, companyId, runId, onCompany, onRun }: Props) {
  const companies = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of runs) map.set(r.company_id, r.companies?.name ?? r.companies?.canonical_domain ?? 'Unknown company');
    return [...map.entries()];
  }, [runs]);
  const companyRuns = runs.filter((r) => r.company_id === companyId);

  return (
    <aside className="space-y-6">
      <label className="block space-y-1">
        <span className="label flex items-center gap-1">
          <Building2 className="h-3.5 w-3.5" /> Company
        </span>
        <select className="field" value={companyId ?? ''} onChange={(e) => onCompany(e.target.value)}>
          {companies.map(([id, name]) => (
            <option key={id} value={id}>{name}</option>
          ))}
        </select>
      </label>

      <div className="space-y-2">
        <p className="label">Analysis runs</p>
        <ul className="space-y-2">
          {companyRuns.map((r) => {
            const selected = r.id === runId;
            return (
              <li key={r.id}>
                <button
                  onClick={() => onRun(r.id)}
                  className={`group w-full rounded-lg border p-3 text-left transition ${
                    selected ? 'border-primary-300 bg-primary-50 shadow-sm' : 'border-ink-200 bg-white hover:border-ink-300 hover:shadow-sm'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-ink-500">{r.id.slice(0, 8)}</span>
                    <Badge tone={STATUS_TONE[r.status]}>{r.status.replace('_', ' ')}</Badge>
                  </div>
                  <p className="mt-2 text-sm font-medium text-ink-800">{formatDate(r.started_at)}</p>
                  <p className="mt-0.5 truncate text-xs text-ink-600" title={`Analyst ${r.analyst_model} / verifier ${r.verifier_model}`}>
                    {r.analyst_provider === r.verifier_provider
                      ? `${providerName(r.analyst_provider)}: ${r.analyst_model}`
                      : `${providerName(r.analyst_provider)} analyst + ${providerName(r.verifier_provider)} verifier`}
                  </p>
                  <div className="mt-1 flex items-center justify-between text-xs text-ink-500">
                    <span>
                      {r.finding_count} finding{r.finding_count === 1 ? '' : 's'} / {usd(r.estimated_cost_usd, 2)}
                    </span>
                    <ChevronRight className={`h-4 w-4 transition ${selected ? 'text-primary-600' : 'text-ink-300 group-hover:translate-x-0.5'}`} />
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
