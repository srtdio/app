// The platform of a workspace, for the post and brief sheets. A platform is
// fixed at creation, so a value once known is cached for the session. The
// WorkspaceProvider primes the cache from the rows it lists; a workspace not
// listed yet (onboarding opens the post sheet on one it just created) is read
// once with an RLS-scoped select. Needs no provider, so the sheets render
// anywhere.

import { useEffect, useState } from 'react';
import { toPostPlatform, type PostPlatform } from '@srtdio/posts';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';

const platforms = new Map<string, PostPlatform>();

/** Record the platform of every listed workspace. Throws on an unknown platform. */
export function primeWorkspacePlatforms(
  rows: ReadonlyArray<{ id: string; platform: string }>,
): void {
  for (const row of rows) platforms.set(row.id, toPostPlatform(row.platform));
}

/** Forget every cached platform (tests). */
export function resetWorkspacePlatforms(): void {
  platforms.clear();
}

/**
 * The platform of a workspace, or null while it resolves (and with no
 * workspace). Pass null to skip the read (e.g. while a sheet is closed).
 */
export function useWorkspacePlatform(workspaceId: string | null): PostPlatform | null {
  const cached = workspaceId === null ? undefined : platforms.get(workspaceId);
  const [state, setState] = useState<{ id: string; platform: PostPlatform } | null>(null);

  useEffect(() => {
    if (workspaceId === null || cached !== undefined) return;
    let cancelled = false;
    void Promise.resolve(
      supabase.from('workspaces').select('platform').eq('id', workspaceId).maybeSingle(),
    ).then(
      ({ data, error }) => {
        if (cancelled || error || data === null) return;
        const platform = toPostPlatform(data.platform);
        platforms.set(workspaceId, platform);
        setState({ id: workspaceId, platform });
      },
      (err: unknown) => {
        logger.error('workspace platform read failed', { error: String(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, cached]);

  if (workspaceId === null) return null;
  if (cached !== undefined) return cached;
  return state !== null && state.id === workspaceId ? state.platform : null;
}
