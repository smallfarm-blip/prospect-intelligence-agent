import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { isReviewer } from '@/lib/reviewApi';

export type Access = { kind: 'loading' } | { kind: 'signed_out' } | { kind: 'pending'; session: Session } | { kind: 'reviewer'; session: Session } | { kind: 'error'; message: string };

export function useReviewerAccess(): Access {
  const [access, setAccess] = useState<Access>({ kind: 'loading' });

  useEffect(() => {
    let active = true;
    const resolve = async (session: Session | null) => {
      if (!session) return active && setAccess({ kind: 'signed_out' });
      try {
        const ok = await isReviewer(session.user.id);
        if (active) setAccess({ kind: ok ? 'reviewer' : 'pending', session });
      } catch (e) {
        if (active) setAccess({ kind: 'error', message: (e as Error).message });
      }
    };
    supabase.auth.getSession().then(({ data }) => resolve(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      (async () => {
        await resolve(session);
      })();
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return access;
}
