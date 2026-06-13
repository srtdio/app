// Pure status filter for the Briefs surface. Search and sort are shared via
// list-sort; this covers the All / Open / Closed chips. listBriefs loads the
// whole surface, so filtering here is correct with no refetch and no N+1.

import type { Brief } from '@srtdio/briefs';
import type { BriefStatus } from '@/components/pages/BriefCard';

export type BriefFilter = 'all' | BriefStatus;

/** Keep every brief for "all", otherwise only those matching the status. */
export function filterBriefsByStatus(briefs: Brief[], filter: BriefFilter): Brief[] {
  if (filter === 'all') return briefs;
  return briefs.filter((brief) => brief.status === filter);
}
