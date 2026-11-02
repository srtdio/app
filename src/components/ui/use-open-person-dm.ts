// The one "open my DM with this person" path: the person card's Message button
// and every Reply privately use it. The cached DM in the device's chat list
// opens at once with no rpc; otherwise startDmChannel (dm_channel_ensure)
// creates or reuses it. Me opens my Personal notes (CommandPalette.openTarget's
// path). A failure shows the chat @mention's MENTION_DM_FAILED toast.

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { startDmChannel } from '@/components/chat/chat-actions';
import { useToast } from '@/components/ui/toast';
import type { ChannelSummary } from '@/lib/chat-reads';
import { chatMessageHref } from '@/lib/inbox/bell-types';
import { logger } from '@/lib/logger';
import { mark } from '@/lib/perf-marks';
import { MENTION_DM_FAILED, personDmRoute } from '@/lib/person-card';
import { useSession } from '@/lib/session-context';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { useWorkspace } from '@/lib/workspace-context';

const NO_ROSTER: readonly ChannelSummary[] = [];

/** The chat list outside a ChatStoreProvider (isolated tests) is empty: every open ensures. */
function useRosterSafe(): readonly ChannelSummary[] {
  try {
    return useChatStore().roster;
  } catch {
    return NO_ROSTER;
  }
}

function useMeSafe(): string | null {
  try {
    return useSession().session?.user.id ?? null;
  } catch {
    return null;
  }
}

function useWorkspaceIdSafe(): string | null {
  try {
    return useWorkspace().workspaceId;
  } catch {
    return null;
  }
}

export interface OpenPersonDmOptions {
  /** Runs with the DM's id right before navigating (Reply privately writes its quote here). */
  beforeOpen?: (channelId: string) => void;
}

/** Open (or create) my DM with a person; me opens my notes. */
export function useOpenPersonDm(): (userId: string, options?: OpenPersonDmOptions) => void {
  const navigate = useNavigate();
  const toast = useToast();
  const roster = useRosterSafe();
  const me = useMeSafe();
  const workspaceId = useWorkspaceIdSafe();

  return useCallback(
    (userId: string, options?: OpenPersonDmOptions) => {
      const route = personDmRoute({ userId, me, workspaceId, roster });
      const open = (channelId: string): void => {
        options?.beforeOpen?.(channelId);
        mark('person-card:dm-open');
        navigate(chatMessageHref(channelId, null));
      };
      if (route.kind === 'open') {
        open(route.channelId);
        return;
      }
      if (route.kind === 'none' || workspaceId === null) return;
      const traceId = generateTraceId();
      void startDmChannel(supabase, { workspaceId, peerUserId: userId, traceId }, open).then(
        (failure) => {
          if (failure === null) return;
          logger.warn('person: dm open failed', { trace_id: traceId, error: failure.message });
          toast.show({ title: MENTION_DM_FAILED });
        },
      );
    },
    [me, workspaceId, roster, navigate, toast],
  );
}
