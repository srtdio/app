import { Navigate, useParams } from 'react-router-dom';
import { BriefDetailPage } from '@/components/pages/BriefDetailPage';
import { useRefResolution } from '@/components/refs/useRefResolution';

/**
 * Route target for `/b/:ref`. Resolves the pretty reference to a concrete brief id
 * and renders the existing brief detail experience for it, keeping the pretty URL
 * in the address bar (never redirecting to /briefs/:id). When the number turns
 * out to be a post, it replace-navigates to the matching /p/:ref. An unparseable
 * ref, unknown workspace key, or missing number renders the detail page's own
 * not-found surface (BriefDetailPage with no id).
 */
export function BriefRefResolver() {
  const { ref } = useParams();
  const resolution = useRefResolution(ref, 'brief');

  switch (resolution.status) {
    case 'loading':
      return <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading brief</div>;
    case 'redirect':
      return <Navigate to={resolution.to} replace />;
    case 'resolved':
      return <BriefDetailPage briefId={resolution.id} />;
    case 'notfound':
      return <BriefDetailPage />;
  }
}
