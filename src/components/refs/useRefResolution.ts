import { useEffect, useState } from 'react';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { parseEntityRef, entityUrlPath } from '@/lib/entityRef';
import {
  resolveWorkspaceIdByKey,
  resolvePostIdByNumber,
  resolveBriefIdByNumber,
} from '@/lib/entity-resolve';

/**
 * The outcome of resolving a pretty reference:
 * - `loading`  while the workspace + entity lookups are in flight;
 * - `resolved` with the concrete post/brief id to render;
 * - `redirect` when the number belongs to the OTHER entity type (a brief on a
 *   /p ref, or a post on a /b ref); `to` is the pretty path to replace-navigate;
 * - `notfound` for an unparseable ref, an unknown workspace key, a missing
 *   number, or any transport error.
 */
export type RefResolution =
  | { status: 'loading' }
  | { status: 'resolved'; id: string }
  | { status: 'redirect'; to: string }
  | { status: 'notfound' };

/**
 * Pure resolution of a raw `<key>-<number>` reference to a post or brief id for
 * the given primary kind. One workspace lookup then one entity lookup; only when
 * the primary lookup misses is the other type probed once, to decide a cross-type
 * redirect. RLS makes a cross-tenant key indistinguishable from not-found, so no
 * tenant is ever special-cased. A transport failure resolves to `notfound` (never
 * a throw): the caller renders the existing not-found surface. React-free so the
 * decision table is unit-tested with a fake client.
 */
export async function resolveRef(
  client: Client,
  rawRef: string | undefined,
  primaryKind: 'post' | 'brief',
): Promise<RefResolution> {
  const parsed = rawRef === undefined ? null : parseEntityRef(rawRef);
  if (parsed === null) return { status: 'notfound' };

  const workspace = await resolveWorkspaceIdByKey(client, parsed.key);
  if (!workspace.ok || workspace.data === null) return { status: 'notfound' };

  const primary =
    primaryKind === 'post'
      ? await resolvePostIdByNumber(client, workspace.data, parsed.number)
      : await resolveBriefIdByNumber(client, workspace.data, parsed.number);
  if (!primary.ok) return { status: 'notfound' };
  if (primary.data !== null) return { status: 'resolved', id: primary.data };

  // Primary type missed: probe the other type once to offer a redirect.
  const otherKind = primaryKind === 'post' ? 'brief' : 'post';
  const other =
    otherKind === 'brief'
      ? await resolveBriefIdByNumber(client, workspace.data, parsed.number)
      : await resolvePostIdByNumber(client, workspace.data, parsed.number);
  if (other.ok && other.data !== null) {
    return { status: 'redirect', to: entityUrlPath(otherKind, parsed.key, parsed.number) };
  }
  return { status: 'notfound' };
}

/**
 * React hook wrapper around {@link resolveRef}: re-resolves whenever the raw ref
 * changes, ignoring a stale in-flight result if the ref changed mid-flight.
 */
export function useRefResolution(
  rawRef: string | undefined,
  primaryKind: 'post' | 'brief',
): RefResolution {
  const [resolution, setResolution] = useState<RefResolution>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setResolution({ status: 'loading' });
    void resolveRef(supabase, rawRef, primaryKind).then((result) => {
      if (active) setResolution(result);
    });
    return () => {
      active = false;
    };
  }, [rawRef, primaryKind]);

  return resolution;
}
