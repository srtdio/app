import { Navigate, useLocation, useParams } from 'react-router-dom';
import { BriefDetailPage } from '@/components/pages/BriefDetailPage';
import { useRefResolution } from '@/components/refs/useRefResolution';
import { knownRefId } from '@/lib/entityRef';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * Route target for `/b/:ref`. Resolves the pretty reference to a concrete brief id
 * and renders the existing brief detail experience for it, keeping the pretty URL
 * in the address bar (never redirecting to /briefs/:id). When the number turns
 * out to be a post, it replace-navigates to the matching /p/:ref. An unparseable
 * ref, unknown workspace key, or missing number renders the detail page's own
 * not-found surface (BriefDetailPage with no id).
 *
 * One loader: while the ref resolves, the detail page itself shows its skeleton
 * (resolving), the same instance once the id lands. One ref_resolve read maps
 * the key and number to the brief (a second only when the number is a post);
 * router state carrying the id for this exact ref skips every lookup.
 */
export function BriefRefResolver() {
  const { ref } = useParams();
  const location = useLocation();
  const { workspaces } = useWorkspace();
  const resolution = useRefResolution(ref, 'brief', {
    workspaces,
    knownId: knownRefId(location.state, 'brief', ref),
  });

  switch (resolution.status) {
    case 'loading':
      return <BriefDetailPage resolving />;
    case 'redirect':
      return <Navigate to={resolution.to} replace />;
    case 'resolved':
      return <BriefDetailPage briefId={resolution.id} />;
    case 'notfound':
      return <BriefDetailPage />;
  }
}
