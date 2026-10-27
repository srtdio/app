import { mark } from '@/lib/perf-marks';
import { useEffect, useState } from 'react';
import type { Client } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { parseEntityRef, entityUrlPath } from '@/lib/entityRef';
import { resolveEntityRef } from '@/lib/entity-resolve';
import { generateTraceId } from '@/lib/trace';

/**
 * The outcome of resolving a pretty reference:
 * - `loading`  while the ref_resolve lookup is in flight;
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

/** What the caller already knows. */
export interface RefHints {
  /**
   * The workspaces this session already loaded (useWorkspace().workspaces).
   * Ignored: ref_resolve answers the workspace and the entity in one call, so a
   * loaded key no longer saves a request. Kept so the route resolvers' call
   * sites stay valid; they can drop it.
   */
  workspaces?: readonly { id: string; key: string | null }[];
}

/**
 * Pure resolution of a raw `<key>-<number>` reference to a post or brief id for
 * the given primary kind. One ref_resolve rpc answers the workspace and the
 * entity together; only when the workspace exists but has no live entity of the
 * primary kind is the other kind asked once (a second ref_resolve), to decide a
 * cross-type redirect. An unknown or hidden key is one call. Both calls carry
 * the same trace id (one action). RLS makes a cross-tenant key
 * indistinguishable from not-found, so no tenant is ever special-cased. A
 * transport failure resolves to `notfound` (never a throw): the caller renders
 * the existing not-found surface. React-free so the decision table is
 * unit-tested with a fake client.
 */
export async function resolveRef(
  client: Client,
  rawRef: string | undefined,
  primaryKind: 'post' | 'brief',
  traceId: string = generateTraceId(),
): Promise<RefResolution> {
  const parsed = rawRef === undefined ? null : parseEntityRef(rawRef);
  if (parsed === null) return { status: 'notfound' };

  const ask = (kind: 'post' | 'brief') =>
    resolveEntityRef(client, { traceId, workspaceKey: parsed.key, kind, number: parsed.number });

  const primary = await ask(primaryKind);
  if (!primary.ok || primary.data.workspaceId === null) return { status: 'notfound' };
  if (primary.data.entityId !== null) return { status: 'resolved', id: primary.data.entityId };

  // The workspace has no such entity of the primary kind: ask the other kind once.
  const otherKind = primaryKind === 'post' ? 'brief' : 'post';
  const other = await ask(otherKind);
  if (other.ok && other.data.entityId !== null) {
    return { status: 'redirect', to: entityUrlPath(otherKind, parsed.key, parsed.number) };
  }
  return { status: 'notfound' };
}

/**
 * React hook wrapper around {@link resolveRef}: re-resolves whenever the raw ref
 * changes, ignoring a stale in-flight result if the ref changed mid-flight.
 * `knownId` (an in-app open's router state for exactly this ref, see
 * knownRefId in src/lib/entityRef.ts) resolves on the first render with no
 * lookup at all; otherwise one ref_resolve (two only for a cross-type
 * redirect probe).
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
    mark('ref:start');
    void resolveRef(supabase, rawRef, primaryKind, generateTraceId()).then((result) => {
      mark('ref:end');
      if (active) setResolution(result);
    });
    return () => {
      active = false;
    };
  }, [rawRef, primaryKind, knownId]);

  return resolution;
}
