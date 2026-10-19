import { useState } from 'react';
import { Building2, LogOut, ScanSearch } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { ReviewWorkspace } from '@/components/ReviewWorkspace';
import { ProspectsWorkspace } from '@/components/prospects/ProspectsWorkspace';

type Tab = 'prospects' | 'findings';

const TABS: Array<{ key: Tab; label: string; icon: typeof Building2 }> = [
  { key: 'prospects', label: 'Prospects', icon: Building2 },
  { key: 'findings', label: 'Finding review', icon: ScanSearch },
];

export function AppShell({ session }: { session: Session }) {
  const [tab, setTab] = useState<Tab>('prospects');
  const [focusCompanyId, setFocusCompanyId] = useState<string | null>(null);

  const openResearch = (companyId: string) => {
    setFocusCompanyId(companyId);
    setTab('findings');
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-ink-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-6">
          <nav className="flex items-center gap-1" aria-label="Sections">
            {TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`relative flex items-center gap-2 px-3 py-4 text-sm font-medium transition ${tab === key ? 'text-ink-900' : 'text-ink-500 hover:text-ink-800'}`}
                aria-current={tab === key ? 'page' : undefined}
              >
                <Icon className={`h-4 w-4 ${tab === key ? 'text-primary-600' : ''}`} />
                {label}
                <span className={`absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary-600 transition-opacity ${tab === key ? 'opacity-100' : 'opacity-0'}`} />
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-3 text-sm text-ink-500">
            <span className="hidden sm:inline">{session.user.email}</span>
            <button className="btn-ghost px-2 py-1" onClick={() => supabase.auth.signOut()}>
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </div>
      </header>
      {tab === 'prospects' ? <ProspectsWorkspace onOpenResearch={openResearch} /> : <ReviewWorkspace focusCompanyId={focusCompanyId} />}
    </div>
  );
}
