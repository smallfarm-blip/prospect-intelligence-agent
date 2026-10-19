import { Search } from 'lucide-react';
import { DISCOVERY_SEGMENTS } from '@/lib/prospectTypes';
import { DEFAULT_PROSPECT_FILTERS, type ProspectFilters, type ProspectView, type ReviewState, type SortKey, type StateFilter } from '@/lib/prospectView';
import { ORIGIN_LABELS, SEGMENT_META, STATE_META } from '@/components/prospects/labels';
import { humanize } from '@/lib/format';

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: 'score', label: 'Evidence score' },
  { key: 'potential', label: 'Highest potential' },
  { key: 'recent', label: 'Most recently added' },
  { key: 'name', label: 'Name' },
];

export function ProspectFilterBar({ value, onChange, views }: { value: ProspectFilters; onChange: (f: ProspectFilters) => void; views: ProspectView[] }) {
  const origins = [...new Set(views.map((v) => v.prospect.origin))];
  const set = <K extends keyof ProspectFilters>(k: K, v: ProspectFilters[K]) => onChange({ ...value, [k]: v });
  const changed = JSON.stringify(value) !== JSON.stringify(DEFAULT_PROSPECT_FILTERS);

  return (
    <div className="card flex flex-wrap items-end gap-3 p-3">
      <label className="relative min-w-[220px] flex-1">
        <span className="sr-only">Search companies</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input className="field pl-9" placeholder="Search name, website, category or description" value={value.search} onChange={(e) => set('search', e.target.value)} />
      </label>
      <Select label="Segment" value={value.segment} onChange={(v) => set('segment', v as ProspectFilters['segment'])}>
        <option value="all">All segments</option>
        {DISCOVERY_SEGMENTS.map((s) => <option key={s} value={s}>{SEGMENT_META[s].label}</option>)}
        <option value="none">No segment (not from discovery)</option>
      </Select>
      <Select label="Review status" value={value.state} onChange={(v) => set('state', v as StateFilter)}>
        <option value="active">Active (open, shortlisted, approved)</option>
        <option value="all">All statuses</option>
        {(Object.keys(STATE_META) as ReviewState[]).map((s) => <option key={s} value={s}>{STATE_META[s].label}</option>)}
      </Select>
      <Select label="Source" value={value.origin} onChange={(v) => set('origin', v)}>
        <option value="all">All sources</option>
        {origins.map((o) => <option key={o} value={o}>{ORIGIN_LABELS[o] ?? humanize(o)}</option>)}
      </Select>
      <Select label="Sort by" value={value.sort} onChange={(v) => set('sort', v as SortKey)}>
        {SORTS.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </Select>
      {changed && (
        <button className="btn-ghost" onClick={() => onChange(DEFAULT_PROSPECT_FILTERS)}>
          Reset
        </button>
      )}
    </div>
  );
}

function Select({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <select className="field py-2 pr-8" value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}
