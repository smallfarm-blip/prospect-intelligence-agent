import { useState } from 'react';
import { ArrowRight, CheckCircle2, FileUp, PenLine } from 'lucide-react';
import { existingDomains, importProspects } from '@/lib/prospectApi';
import type { ImportResult, ImportRow } from '@/lib/prospectTypes';
import { MAX_IMPORT, previewImport, rowsFromCsv, type CandidateStatus, type ImportCandidate } from '@/lib/prospectView';
import { Badge, ErrorNote, type Tone } from '@/components/ui';
import { Modal } from '@/components/prospects/Modal';

type Mode = 'manual' | 'csv';

const STATUS: Record<CandidateStatus, { label: string; tone: Tone }> = {
  new: { label: 'Will be added', tone: 'success' },
  existing: { label: 'Already exists', tone: 'warning' },
  repeat: { label: 'Repeated in file', tone: 'warning' },
  invalid: { label: 'Cannot import', tone: 'error' },
};

const EMPTY: ImportRow = { name: '', domain: '', category: '', country: '', notes: '' };

interface Props {
  onClose: () => void;
  onImported: () => void;
  onOpen: (companyId: string) => void;
}

export function ImportDialog({ onClose, onImported, onOpen }: Props) {
  const [mode, setMode] = useState<Mode>('manual');
  const [manual, setManual] = useState<ImportRow>(EMPTY);
  const [csv, setCsv] = useState('');
  const [preview, setPreview] = useState<ImportCandidate[] | null>(null);
  const [results, setResults] = useState<ImportResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = (m: Mode) => {
    setMode(m);
    setPreview(null);
    setResults(null);
    setError(null);
  };

  const check = async () => {
    setError(null);
    const parsed = mode === 'manual' ? { rows: [{ line: 1, row: manual }], error: null } : rowsFromCsv(csv);
    if (parsed.error) return setError(parsed.error);
    setBusy(true);
    try {
      const draft = previewImport(parsed.rows, new Map());
      const known = await existingDomains(draft.filter((c) => c.status !== 'invalid').map((c) => c.domain));
      setPreview(previewImport(parsed.rows, known));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toAdd = preview?.filter((c) => c.status === 'new') ?? [];

  const commit = async () => {
    if (toAdd.length > MAX_IMPORT) return setError(`Import up to ${MAX_IMPORT} companies at a time`);
    setBusy(true);
    setError(null);
    try {
      const clean = (s?: string) => s?.trim() || undefined;
      const rows = toAdd.map(({ row, domain }) => ({ name: row.name.trim(), domain, category: clean(row.category), country: clean(row.country), notes: clean(row.notes) }));
      setResults(await importProspects(mode === 'manual' ? 'manual_entry' : 'csv_import', rows));
      onImported();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1_000_000) return setError('That file is larger than 1 MB');
    setCsv(await file.text());
    setPreview(null);
  };

  return (
    <Modal title="Add companies" onClose={onClose} wide>
      {results ? (
        <Results results={results} onOpen={onOpen} onDone={onClose} onMore={() => { setManual(EMPTY); setCsv(''); reset(mode); }} />
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:max-w-sm">
            <ModeButton active={mode === 'manual'} onClick={() => reset('manual')} icon={<PenLine className="h-4 w-4" />} label="One company" />
            <ModeButton active={mode === 'csv'} onClick={() => reset('csv')} icon={<FileUp className="h-4 w-4" />} label="CSV import" />
          </div>

          {mode === 'manual' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Company name" required value={manual.name} onChange={(v) => { setManual({ ...manual, name: v }); setPreview(null); }} />
              <Input label="Website" required placeholder="example.com" value={manual.domain} onChange={(v) => { setManual({ ...manual, domain: v }); setPreview(null); }} />
              <Input label="Category" placeholder="e.g. home goods" value={manual.category ?? ''} onChange={(v) => setManual({ ...manual, category: v })} />
              <Input label="Country" placeholder="e.g. US" value={manual.country ?? ''} onChange={(v) => setManual({ ...manual, country: v })} />
              <label className="sm:col-span-2">
                <span className="label">Notes</span>
                <textarea className="field mt-1 min-h-[72px]" maxLength={1000} value={manual.notes ?? ''} onChange={(e) => setManual({ ...manual, notes: e.target.value })} placeholder="Why this company is worth a look, and where you heard of it" />
              </label>
              <p className="text-xs text-ink-500 sm:col-span-2">Category and country are saved as unconfirmed reviewer notes. They are not treated as verified evidence.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-ink-600">
                Include a header row with <strong>name</strong> and <strong>website</strong> (or domain). Optional columns: category, country, notes. Up to {MAX_IMPORT} companies.
              </p>
              <input type="file" accept=".csv,text/csv" onChange={(e) => void loadFile(e.target.files?.[0])} className="block text-sm text-ink-600 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-100 file:px-3 file:py-2 file:text-sm file:font-medium file:text-ink-700 hover:file:bg-ink-200" />
              <textarea className="field min-h-[140px] font-mono text-xs" placeholder={'name,website,category,country\nAcme Home,acmehome.com,home goods,US'} value={csv} onChange={(e) => { setCsv(e.target.value); setPreview(null); }} />
            </div>
          )}

          {error && <ErrorNote message={error} />}

          {preview && <PreviewTable rows={preview} />}

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-ink-100 pt-4">
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
            {!preview ? (
              <button className="btn-primary" disabled={busy || (mode === 'manual' ? !manual.name.trim() || !manual.domain.trim() : !csv.trim())} onClick={check}>
                {busy ? 'Checking...' : 'Check for duplicates'}
              </button>
            ) : (
              <button className="btn-primary" disabled={busy || toAdd.length === 0} onClick={commit}>
                {busy ? 'Adding...' : toAdd.length === 0 ? 'Nothing new to add' : `Add ${toAdd.length} ${toAdd.length === 1 ? 'company' : 'companies'}`}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

function PreviewTable({ rows }: { rows: ImportCandidate[] }) {
  const counts = rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(STATUS) as CandidateStatus[]).filter((s) => counts[s]).map((s) => <Badge key={s} tone={STATUS[s].tone}>{counts[s]} {STATUS[s].label.toLowerCase()}</Badge>)}
      </div>
      <div className="max-h-72 overflow-auto rounded-lg border border-ink-100">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-ink-50 text-xs text-ink-500">
            <tr>
              <th className="px-3 py-2 font-medium">Line</th>
              <th className="px-3 py-2 font-medium">Company</th>
              <th className="px-3 py-2 font-medium">Website</th>
              <th className="px-3 py-2 font-medium">Result</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-50">
            {rows.map((r) => (
              <tr key={r.line} className={r.status === 'new' ? '' : 'bg-ink-50/50'}>
                <td className="px-3 py-2 text-xs text-ink-400">{r.line}</td>
                <td className="px-3 py-2 text-ink-800">{r.row.name || '-'}</td>
                <td className="px-3 py-2 text-ink-600">{r.domain || r.row.domain || '-'}</td>
                <td className="px-3 py-2">
                  <Badge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Badge>
                  {r.note && <span className="ml-2 text-xs text-ink-500">{r.note}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Results({ results, onOpen, onDone, onMore }: { results: ImportResult[]; onOpen: (id: string) => void; onDone: () => void; onMore: () => void }) {
  const added = results.filter((r) => r.outcome === 'new');
  const skipped = results.filter((r) => r.outcome !== 'new');
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-success-700">
        <CheckCircle2 className="h-5 w-5" />
        <span className="font-medium">{added.length} {added.length === 1 ? 'company' : 'companies'} added</span>
      </div>
      {skipped.length > 0 && <p className="text-sm text-warning-700">{skipped.length} skipped because they already existed or were not valid by the time they were saved.</p>}
      <p className="text-sm text-ink-600">New companies start in the Not scored queue. They are scored once the prospecting worker rescores or screens them.</p>
      <ul className="divide-y divide-ink-100 rounded-lg border border-ink-100">
        {added.map((r) => (
          <li key={r.company_id ?? r.domain}>
            <button className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-ink-50" onClick={() => r.company_id && onOpen(r.company_id)}>
              <span><span className="font-medium text-ink-900">{r.name}</span> <span className="text-ink-500">{r.domain}</span></span>
              <ArrowRight className="h-4 w-4 text-ink-400" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <button className="btn-ghost" onClick={onMore}>Add more</button>
        <button className="btn-primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function ModeButton({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={`flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${active ? 'border-primary-600 bg-primary-50 text-primary-800' : 'border-ink-200 text-ink-600 hover:bg-ink-50'}`}>
      {icon}
      {label}
    </button>
  );
}

function Input({ label, value, onChange, placeholder, required }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <label>
      <span className="label">{label}{required && <span className="text-error-600"> *</span>}</span>
      <input className="field mt-1" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} maxLength={200} />
    </label>
  );
}
