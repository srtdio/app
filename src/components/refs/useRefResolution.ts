import { useEffect, useRef, useState } from 'react';
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
type RefResolution =
  | { status: 'loading' }
  | { status: 'resolved'; id: string }
  | { status: 'redirect'; to: string }
  | { status: 'notfound' };

/** What the caller already knows, so the resolver can skip lookups. */
export interface RefHints {
  /**
   * The workspaces this session already loaded (useWorkspace().workspaces): a
   * ref whose key is among them needs no workspace lookup. A key not among
   * them still gets the lookup (never a guess).
   */
  workspaces?: readonly { id: string; key: string | null }[];
}

/** The loaded workspace id for an uppercase key, or null when it is not loaded. */
export function loadedWorkspaceId(workspaces: RefHints['workspaces'], key: string): string | null {
  const hit = workspaces?.find((w) => w.key !== null && w.key.toUpperCase() === key);
  return hit?.id ?? null;
}

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
  hints: RefHints = {},
): Promise<RefResolution> {
  const parsed = rawRef === undefined ? null : parseEntityRef(rawRef);
  if (parsed === null) return { status: 'notfound' };

  // A key this session already loaded resolves in memory (no round trip).
  const loaded = loadedWorkspaceId(hints.workspaces, parsed.key);
  const workspace =
    loaded !== null
      ? { ok: true as const, data: loaded }
      : await resolveWorkspaceIdByKey(client, parsed.key);
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
 * `knownId` (an in-app open's router state for exactly this ref, see
 * knownRefId in src/lib/entityRef.ts) resolves on the first render with no
 * lookup at all; the loaded workspaces skip the workspace lookup.
 */
export function useRefResolution(
  rawRef: string | undefined,
  primaryKind: 'post' | 'brief',
  hints: RefHints & { knownId?: string | null } = {},
): RefResolution {
  const knownId = hints.knownId ?? null;
  const [resolution, setResolution] = useState<RefResolution>(() =>
    knownId !== null ? { status: 'resolved', id: knownId } : { status: 'loading' },
  );
  // Read at resolve time, not a dependency: the list arriving or refreshing
  // never re-runs a resolution for the same ref.
  const workspacesRef = useRef(hints.workspaces);
  workspacesRef.current = hints.workspaces;

  useEffect(() => {
    if (knownId !== null) {
      setResolution((prev) =>
        prev.status === 'resolved' && prev.id === knownId
          ? prev
          : { status: 'resolved', id: knownId },
      );
      return;
    }
    let active = true;
    setResolution((prev) => (prev.status === 'loading' ? prev : { status: 'loading' }));
    const workspaces = workspacesRef.current;
    const lookupHints: RefHints = workspaces === undefined ? {} : { workspaces };
    void resolveRef(supabase, rawRef, primaryKind, lookupHints).then((result) => {
      if (active) setResolution(result);
    });
    return () => {
      active = false;
    };
  }, [rawRef, primaryKind, knownId]);

  return resolution;
}
