import { Navigate, useLocation, useParams } from 'react-router-dom';
import { PostDetailPage } from '@/components/pages/PostDetailPage';
import { useRefResolution } from '@/components/refs/useRefResolution';
import { knownRefId } from '@/lib/entityRef';
import { useWorkspace } from '@/lib/workspace-context';

/**
 * Route target for `/p/:ref`. Resolves the pretty reference to a concrete post id
 * and renders the existing post detail experience for it, keeping the pretty URL
 * in the address bar (never redirecting to /posts/:id). When the number turns out
 * to be a brief, it replace-navigates to the matching /b/:ref. An unparseable
 * ref, unknown workspace key, or missing number renders the detail page's own
 * not-found surface (PostDetailPage with no id).
 *
 * One loader: while the ref resolves, the detail page itself shows its skeleton
 * (resolving), and it is the same page instance once the id lands, so there is
 * no resolver spinner before the skeleton. An open from a post card carries the
 * id in router state (no lookup at all); otherwise one ref_resolve read maps
 * the key and number to the post (a second only when the number is a brief).
 */
export function PostRefResolver() {
  const { ref } = useParams();
  const location = useLocation();
  const { workspaces } = useWorkspace();
  const resolution = useRefResolution(ref, 'post', {
    workspaces,
    knownId: knownRefId(location.state, 'post', ref),
  });

  switch (resolution.status) {
    case 'loading':
      return <PostDetailPage resolving />;
    case 'redirect':
      return <Navigate to={resolution.to} replace />;
    case 'resolved':
      return <PostDetailPage postId={resolution.id} />;
    case 'notfound':
      return <PostDetailPage />;
  }
}
