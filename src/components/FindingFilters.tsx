import { RotateCcw, SlidersHorizontal } from 'lucide-react';
import { CLASSES, CLASS_LABELS, PRIORITIES, PRIORITY_LABELS, READINESS_LABELS } from '@/lib/assessment';
import { DEFAULT_FILTERS, type SortKey, type ViewFilters } from '@/lib/findingView';
import type { OutreachReadiness } from '@/lib/types';

const READINESS: OutreachReadiness[] = ['not_ready', 'exploratory', 'ready'];
const SORTS: Array<{ value: SortKey; label: string }> = [
  { value: 'analysis', label: 'Analysis order' },
  { value: 'priority', label: 'Priority, high first' },
  { value: 'class', label: 'Evidence maturity' },
];

function Select({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <label className="flex min-w-[150px] flex-1 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-ink-500">{label}</span>
      <select className="field py-1.5 text-sm" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </label>
  );
}

export function FindingFilters({ value, onChange }: { value: ViewFilters; onChange: (f: ViewFilters) => void }) {
  const set = <K extends keyof ViewFilters>(k: K) => (v: string) => onChange({ ...value, [k]: v as ViewFilters[K] });
  const changed = JSON.stringify(value) !== JSON.stringify(DEFAULT_FILTERS);
  return (
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-ink-200 bg-white p-3">
      <SlidersHorizontal className="mb-2 hidden h-4 w-4 text-ink-400 sm:block" />
      <Select label="Maturity" value={value.findingClass} onChange={set('findingClass')} options={[{ value: 'all', label: 'All' }, ...CLASSES.map((c) => ({ value: c, label: CLASS_LABELS[c] }))]} />
      <Select label="Priority" value={value.priority} onChange={set('priority')} options={[{ value: 'all', label: 'All' }, ...PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }))]} />
      <Select
        label="Outreach"
        value={value.readiness}
        onChange={set('readiness')}
        options={[{ value: 'all', label: 'All' }, { value: 'undecided', label: 'Not decided' }, ...READINESS.map((r) => ({ value: r, label: READINESS_LABELS[r] }))]}
      />
      <Select label="Order" value={value.sort} onChange={set('sort')} options={SORTS} />
      {changed && (
        <button className="btn-ghost mb-0.5 px-2 py-1.5 text-sm" onClick={() => onChange(DEFAULT_FILTERS)}>
          <RotateCcw className="h-4 w-4" /> Reset
        </button>
      )}
    </div>
  );
}
