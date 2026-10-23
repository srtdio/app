// Data hook for the Members panel: three reads per load, the membership read
// (listMembers) together with one invite_delivery_list call, then a single
// batched profile read (readProfiles over the distinct user ids). No per-row
// fetches. Exposes a refetch used after a remove, a cancelled invite, an edited
// invite, a role change, or a fresh invite.

import { useCallback, useEffect, useState } from 'react';
import { listMembers } from '@srtdio/workspace';
import { readProfiles } from '@/lib/chat-reads';
import type { ChatProfile } from '@/lib/chat-reads';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { deliveryByMember } from './members-data';
import type { InviteDeliveryStatus, WorkspaceMemberRow } from './members-data';

export interface MembersData {
  loading: boolean;
  error: string | null;
  rows: WorkspaceMemberRow[];
  profiles: Map<string, ChatProfile>;
  /** Pending invite member_id -> latest invite email status. */
  delivery: Map<string, InviteDeliveryStatus>;
  refetch: () => void;
}

export function useMembersData(workspaceId: string | null): MembersData {
  const [rows, setRows] = useState<WorkspaceMemberRow[]>([]);
  const [profiles, setProfiles] = useState<Map<string, ChatProfile>>(new Map());
  const [delivery, setDelivery] = useState<Map<string, InviteDeliveryStatus>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumping this re-runs the effect below; simpler than duplicating the fetch.
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (workspaceId === null) {
      setRows([]);
      setProfiles(new Map());
      setDelivery(new Map());
      setLoading(false);
      setError(null);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    void (async () => {
      // Args as a variable: invite_delivery_list is a read with no trace param.
      const deliveryArgs = { p_workspace_id: workspaceId };
      const [membersRes, deliveryRes] = await Promise.all([
        listMembers(supabase, workspaceId),
        supabase.rpc('invite_delivery_list', deliveryArgs),
      ]);
      if (!active) return;
      // The status pill is extra: a failed read leaves the list without it.
      if (deliveryRes.error) {
        logger.warn('invite delivery list failed', { error: deliveryRes.error.message });
      }
      setDelivery(deliveryByMember(deliveryRes.error ? [] : deliveryRes.data));
      if (!membersRes.ok) {
        setError(membersRes.error.message);
        setRows([]);
        setProfiles(new Map());
        setLoading(false);
        return;
      }

      const memberRows = membersRes.data;
      const profilesRes = await readProfiles(
        supabase,
        memberRows.map((r) => r.user_id),
      );
      if (!active) return;
      if (!profilesRes.ok) {
        setError(profilesRes.error.message);
        setRows(memberRows);
        setProfiles(new Map());
        setLoading(false);
        return;
      }

      setRows(memberRows);
      setProfiles(new Map(profilesRes.data.map((p) => [p.userId, p])));
      setLoading(false);
    })().catch((err: unknown) => {
      if (!active) return;
      logger.error('members load failed', { error: String(err) });
      setError(String(err));
      setLoading(false);
    });

    return () => {
      active = false;
    };
  }, [workspaceId, nonce]);

  return { loading, error, rows, profiles, delivery, refetch };
}
