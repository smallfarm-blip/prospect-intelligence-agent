import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, RotateCcw, XCircle } from 'lucide-react';
import type { Decision, VerificationStatus } from '@/lib/types';

type Tone = 'neutral' | 'primary' | 'secondary' | 'accent' | 'success' | 'warning' | 'error';

const TONES: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  primary: 'bg-primary-50 text-primary-800 ring-primary-200',
  secondary: 'bg-secondary-50 text-secondary-800 ring-secondary-200',
  accent: 'bg-accent-50 text-accent-800 ring-accent-200',
  success: 'bg-success-50 text-success-700 ring-success-200',
  warning: 'bg-warning-50 text-warning-700 ring-warning-200',
  error: 'bg-error-50 text-error-700 ring-error-200',
};

export function Badge({ tone = 'neutral', icon, children }: { tone?: Tone; icon?: ReactNode; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}>
      {icon}
      {children}
    </span>
  );
}

const VERIFICATION: Record<VerificationStatus | 'not_verified', { tone: Tone; label: string; icon: ReactNode }> = {
  supported: { tone: 'success', label: 'Verified: supported', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  needs_revision: { tone: 'warning', label: 'Verifier: needs revision', icon: <AlertTriangle className="h-3.5 w-3.5" /> },
  rejected: { tone: 'error', label: 'Verifier: rejected', icon: <XCircle className="h-3.5 w-3.5" /> },
  not_verified: { tone: 'neutral', label: 'Not verified', icon: <CircleDashed className="h-3.5 w-3.5" /> },
};

export function VerificationBadge({ status }: { status: VerificationStatus | null }) {
  const v = VERIFICATION[status ?? 'not_verified'];
  return <Badge tone={v.tone} icon={v.icon}>{v.label}</Badge>;
}

const DECISION: Record<Decision, { tone: Tone; label: string; icon: ReactNode }> = {
  approved: { tone: 'primary', label: 'You approved', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
  rejected: { tone: 'error', label: 'You rejected', icon: <XCircle className="h-3.5 w-3.5" /> },
  revise: { tone: 'accent', label: 'Revision requested', icon: <RotateCcw className="h-3.5 w-3.5" /> },
};

export function DecisionBadge({ decision }: { decision: Decision | null }) {
  if (!decision) return <Badge>Awaiting review</Badge>;
  const d = DECISION[decision];
  return <Badge tone={d.tone} icon={d.icon}>{d.label}</Badge>;
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-error-200 bg-error-50 px-3 py-2 text-sm text-error-700">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 text-sm text-ink-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-200 border-t-primary-600" />
      {label}
    </div>
  );
}
