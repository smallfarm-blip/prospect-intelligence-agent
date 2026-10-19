import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui';
import type { ProspectDetail } from '@/lib/prospectTypes';
import { formatDate, humanize, providerName } from '@/lib/format';
import { CONFIDENCE_TONE, SEGMENT_META } from '@/components/prospects/labels';

type Tab = 'sources' | 'people' | 'signals' | 'facts';

export function safeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function Ext({ href, children }: { href: string | null | undefined; children: React.ReactNode }) {
  const url = safeUrl(href);
  if (!url) return <span>{children}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary-700 underline-offset-2 hover:underline">
      {children}
      <ExternalLink className="h-3 w-3 shrink-0" />
    </a>
  );
}

export function EvidenceTabs({ detail }: { detail: ProspectDetail }) {
  const [tab, setTab] = useState<Tab>('sources');
  const tabs: Array<{ key: Tab; label: string; count: number }> = [
    { key: 'sources', label: 'Sources', count: detail.sources.length },
    { key: 'people', label: 'People', count: detail.decisionMakers.length },
    { key: 'signals', label: 'Screening signals', count: detail.signals.length },
    { key: 'facts', label: 'Facts', count: detail.facts.length },
  ];
  return (
    <section className="card overflow-hidden">
      <div className="flex gap-1 overflow-x-auto border-b border-ink-100 px-3" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)}
            className={`relative whitespace-nowrap px-3 py-3 text-sm font-medium transition ${tab === t.key ? 'text-ink-900' : 'text-ink-500 hover:text-ink-800'}`}>
            {t.label} <span className="text-xs text-ink-400">{t.count}</span>
            {tab === t.key && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary-600" />}
          </button>
        ))}
      </div>
      <div className="p-5">
        {tab === 'sources' && <Sources detail={detail} />}
        {tab === 'people' && <People detail={detail} />}
        {tab === 'signals' && <Signals detail={detail} />}
        {tab === 'facts' && <Facts detail={detail} />}
      </div>
    </section>
  );
}

const Empty = ({ text }: { text: string }) => <p className="text-sm text-ink-500">{text}</p>;

function Sources({ detail }: { detail: ProspectDetail }) {
  if (!detail.sources.length) return <Empty text="No sources recorded for this company." />;
  return (
    <ul className="space-y-4">
      {detail.sources.map((s) => (
        <li key={s.id} className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Ext href={s.url}>{s.title || s.url}</Ext>
            {s.discovery_segment && <Badge tone={SEGMENT_META[s.discovery_segment].tone}>{SEGMENT_META[s.discovery_segment].label}</Badge>}
            <Badge>{humanize(s.kind)}</Badge>
          </div>
          {s.excerpt && <p className="line-clamp-3 text-sm text-ink-600">{s.excerpt}</p>}
          <p className="text-xs text-ink-400">
            {s.provider_calls ? `${providerName(s.provider_calls.provider)}${s.provider_calls.query ? ` · "${s.provider_calls.query}"` : ''}` : 'Entered by a reviewer'}
            {s.published_at && ` · published ${formatDate(s.published_at)}`} · found {formatDate(s.created_at)}
          </p>
        </li>
      ))}
    </ul>
  );
}

function People({ detail }: { detail: ProspectDetail }) {
  if (!detail.decisionMakers.length) return <Empty text="No decision-makers found yet. People search runs during screening." />;
  return (
    <ul className="grid gap-3 md:grid-cols-2">
      {detail.decisionMakers.map((d) => {
        const review = d.decision_maker_reviews[0];
        return (
          <li key={d.id} className="rounded-lg border border-ink-100 p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-medium text-ink-900">{d.profile_url ? <Ext href={d.profile_url}>{d.name}</Ext> : d.name}</div>
                <div className="text-sm text-ink-600">{d.title ?? humanize(d.role_category)}</div>
              </div>
              {review ? (
                <Badge tone={review.decision === 'confirmed' ? 'success' : 'error'}>Reviewer {review.decision}</Badge>
              ) : (
                <Badge>Unconfirmed</Badge>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {d.match_confidence && <Badge tone={CONFIDENCE_TONE[d.match_confidence]}>{d.match_confidence} match</Badge>}
              {d.employment_status && <Badge>{humanize(d.employment_status)} role</Badge>}
              {d.role_started_on && <Badge>since {d.role_started_on}</Badge>}
            </div>
            {d.match_basis && <p className="mt-2 text-xs text-ink-500">{d.match_basis}</p>}
            {d.source_url && <p className="mt-1 text-xs"><Ext href={d.source_url}>Source</Ext></p>}
          </li>
        );
      })}
    </ul>
  );
}

function Signals({ detail }: { detail: ProspectDetail }) {
  if (!detail.signals.length) return <Empty text="No screening signals yet. Signals are added when the company is screened." />;
  return (
    <ul className="space-y-4">
      {detail.signals.map((s) => (
        <li key={s.id} className="rounded-lg border border-ink-100 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium text-ink-900">{s.title}</span>
            <Badge tone="secondary">{humanize(s.signal_type)}</Badge>
            <Badge tone={CONFIDENCE_TONE[s.confidence]}>{s.confidence} confidence</Badge>
          </div>
          <dl className="mt-3 grid gap-2 text-sm md:grid-cols-2">
            <Field label="Observed" value={s.observed_evidence} />
            <Field label="Interpretation" value={s.interpretation} />
            <Field label="Why it matters" value={s.business_relevance} />
            <Field label="Next validation" value={s.next_validation} />
          </dl>
          {s.critical_unknowns.length > 0 && <p className="mt-2 text-xs text-ink-500">Unknowns: {s.critical_unknowns.join('; ')}</p>}
          {s.source_urls.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-3 text-xs">
              {s.source_urls.map((u, i) => <Ext key={u} href={u}>Source {i + 1}</Ext>)}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

const Field = ({ label, value }: { label: string; value: string }) => (
  <div>
    <dt className="text-xs font-medium text-ink-500">{label}</dt>
    <dd className="text-ink-700">{value}</dd>
  </div>
);

function Facts({ detail }: { detail: ProspectDetail }) {
  if (!detail.facts.length) return <Empty text="No facts recorded yet." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-ink-500">
          <tr className="border-b border-ink-100">
            <th className="py-2 pr-4 font-medium">Attribute</th>
            <th className="py-2 pr-4 font-medium">Value</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 pr-4 font-medium">From</th>
            <th className="py-2 font-medium">Checked</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-50">
          {detail.facts.map((f) => (
            <tr key={f.id} className="align-top">
              <td className="py-2 pr-4 text-ink-700">{humanize(f.attribute)}</td>
              <td className="py-2 pr-4 text-ink-900">{f.value_text}</td>
              <td className="py-2 pr-4"><Badge tone={f.status === 'verified' ? 'success' : f.status === 'contradicted' ? 'error' : 'neutral'}>{humanize(f.status)}</Badge></td>
              <td className="py-2 pr-4 text-ink-600">
                {f.source_url ? <Ext href={f.source_url}>{f.provider ? providerName(f.provider) : humanize(f.source_type)}</Ext> : f.provider ? providerName(f.provider) : humanize(f.source_type)}
              </td>
              <td className="py-2 text-xs text-ink-500">{formatDate(f.checked_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
