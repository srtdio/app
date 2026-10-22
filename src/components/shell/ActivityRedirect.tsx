import type { ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { NOTIFICATIONS_PATH } from '@/components/shell/NotificationsButton';

/** /activity (old links, bookmarks): Notifications in place, query string kept. */
export function ActivityRedirect(): ReactElement {
  const { search } = useLocation();
  return <Navigate to={`${NOTIFICATIONS_PATH}${search}`} replace />;
}
