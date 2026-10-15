import { useReviewerAccess } from '@/hooks/useReviewerAccess';
import { AuthScreen } from '@/components/AuthScreen';
import { AccessPending } from '@/components/AccessPending';
import { ReviewWorkspace } from '@/components/ReviewWorkspace';
import { ErrorNote, Spinner } from '@/components/ui';

export default function App() {
  const access = useReviewerAccess();
  switch (access.kind) {
    case 'loading':
      return <div className="flex min-h-screen items-center justify-center"><Spinner label="Checking your access..." /></div>;
    case 'error':
      return <div className="mx-auto max-w-lg p-10"><ErrorNote message={access.message} /></div>;
    case 'signed_out':
      return <AuthScreen />;
    case 'pending':
      return <AccessPending session={access.session} />;
    case 'reviewer':
      return <ReviewWorkspace session={access.session} />;
  }
}
