import { Navigate, useParams } from 'react-router-dom';
import { PostDetailPage } from '@/components/pages/PostDetailPage';
import { useRefResolution } from '@/components/refs/useRefResolution';

/**
 * Route target for `/p/:ref`. Resolves the pretty reference to a concrete post id
 * and renders the existing post detail experience for it, keeping the pretty URL
 * in the address bar (never redirecting to /posts/:id). When the number turns out
 * to be a brief, it replace-navigates to the matching /b/:ref. An unparseable
 * ref, unknown workspace key, or missing number renders the detail page's own
 * not-found surface (PostDetailPage with no id).
 */
export function PostRefResolver() {
  const { ref } = useParams();
  const resolution = useRefResolution(ref, 'post');

  switch (resolution.status) {
    case 'loading':
      return <div className="px-4 md:px-6 py-10 text-sm text-fg-3">Loading post</div>;
    case 'redirect':
      return <Navigate to={resolution.to} replace />;
    case 'resolved':
      return <PostDetailPage postId={resolution.id} />;
    case 'notfound':
      return <PostDetailPage />;
  }
}
