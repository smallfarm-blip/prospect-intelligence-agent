import { useState, type FormEvent } from 'react';
import { ArrowRight, ScanSearch } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ErrorNote } from '@/components/ui';

function friendly(message: string): string {
  if (/invalid login/i.test(message)) return 'That email and password do not match an account.';
  if (/already registered/i.test(message)) return 'An account with this email already exists. Sign in instead.';
  if (/fetch/i.test(message)) return 'Could not reach the server. Check your connection and try again.';
  return message;
}

export function AuthScreen() {
  const [mode, setMode] = useState<'sign_in' | 'sign_up'>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } =
      mode === 'sign_in'
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    if (err) setError(friendly(err.message));
    setBusy(false);
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-2">
      <div className="hidden flex-col justify-between bg-ink-900 p-12 text-ink-100 lg:flex">
        <div className="flex items-center gap-2 text-sm font-medium">
          <ScanSearch className="h-5 w-5 text-primary-300" />
          Prospect Intelligence
        </div>
        <div className="max-w-md">
          <h1 className="font-serif text-4xl font-semibold text-white">Every finding earns its place.</h1>
          <p className="mt-4 text-ink-300">
            Review evidence-backed opportunity hypotheses, check them against the screenshots they cite, and record your judgement.
          </p>
        </div>
        <p className="text-xs text-ink-400">Reviewer access only</p>
      </div>

      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="w-full max-w-sm animate-fade-up space-y-6">
          <div>
            <h2 className="font-serif text-2xl font-semibold text-ink-900">{mode === 'sign_in' ? 'Sign in' : 'Create an account'}</h2>
            <p className="mt-1 text-sm text-ink-500">
              {mode === 'sign_in' ? 'Use your reviewer account.' : 'New accounts need reviewer approval before they can see findings.'}
            </p>
          </div>
          <div className="space-y-4">
            <label className="block space-y-1">
              <span className="label">Email</span>
              <input className="field" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="block space-y-1">
              <span className="label">Password</span>
              <input
                className="field"
                type="password"
                autoComplete={mode === 'sign_in' ? 'current-password' : 'new-password'}
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>
          {error && <ErrorNote message={error} />}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Please wait...' : mode === 'sign_in' ? 'Sign in' : 'Create account'}
            {!busy && <ArrowRight className="h-4 w-4" />}
          </button>
          <p className="text-center text-sm text-ink-500">
            {mode === 'sign_in' ? 'No account yet?' : 'Already have an account?'}{' '}
            <button
              type="button"
              className="font-medium text-primary-700 hover:text-primary-800"
              onClick={() => {
                setMode(mode === 'sign_in' ? 'sign_up' : 'sign_in');
                setError(null);
              }}
            >
              {mode === 'sign_in' ? 'Create one' : 'Sign in'}
            </button>
          </p>
        </form>
      </div>
    </div>
  );
}
