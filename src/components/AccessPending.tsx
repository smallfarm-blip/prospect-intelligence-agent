import { useState } from 'react';
import { Check, Copy, LogOut, ShieldAlert } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

export function AccessPending({ session }: { session: Session }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(session.user.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="card w-full max-w-lg animate-fade-up p-8">
        <ShieldAlert className="h-8 w-8 text-warning-600" />
        <h1 className="mt-4 font-serif text-2xl font-semibold text-ink-900">Waiting for reviewer approval</h1>
        <p className="mt-2 text-sm text-ink-600">
          You are signed in as <span className="font-medium text-ink-800">{session.user.email}</span>, but this account is not on the reviewer list yet.
          Share the account ID below with the project owner so it can be added.
        </p>
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3">
          <code className="flex-1 truncate font-mono text-xs text-ink-700">{session.user.id}</code>
          <button className="btn-ghost px-2 py-1" onClick={copy} aria-label="Copy account ID">
            {copied ? <Check className="h-4 w-4 text-success-600" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
        <div className="mt-6 flex justify-between">
          <button className="btn-ghost" onClick={() => window.location.reload()}>I have been added</button>
          <button className="btn-ghost" onClick={() => supabase.auth.signOut()}>
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
