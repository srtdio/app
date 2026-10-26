// The Members panel's invite email status read: one invite_delivery_list call
// per load. Not member data, so it stays out of the shared members cache; the
// panel's refetch re-runs it alongside the members re-read.

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { deliveryByMember } from './members-data';
import type { InviteDeliveryStatus } from './members-data';

interface InviteDeliveryState {
  /** Pending invite member_id -> latest invite email status. */
  delivery: Map<string, InviteDeliveryStatus>;
  refetch: () => void;
}

export function useInviteDelivery(workspaceId: string | null): InviteDeliveryState {
  const [delivery, setDelivery] = useState<Map<string, InviteDeliveryStatus>>(new Map());
  // Bumping this re-runs the effect below; simpler than duplicating the fetch.
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (workspaceId === null) {
      setDelivery(new Map());
      return;
    }
    let active = true;
    void (async () => {
      // Args as a variable: invite_delivery_list is a read with no trace param.
      const deliveryArgs = { p_workspace_id: workspaceId };
      const deliveryRes = await supabase.rpc('invite_delivery_list', deliveryArgs);
      if (!active) return;
      // The status pill is extra: a failed read leaves the list without it.
      if (deliveryRes.error) {
        logger.warn('invite delivery list failed', { error: deliveryRes.error.message });
      }
      setDelivery(deliveryByMember(deliveryRes.error ? [] : deliveryRes.data));
    })().catch((err: unknown) => {
      if (!active) return;
      logger.warn('invite delivery list failed', { error: String(err) });
      setDelivery(new Map());
    });
    return () => {
      active = false;
    };
  }, [workspaceId, nonce]);

  return { delivery, refetch };
}
