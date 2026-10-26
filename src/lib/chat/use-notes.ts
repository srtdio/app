// Chat home's Personal notes: the summary built from the session (the tile
// paints from it at once), notes_channel_ensure once per workspace per session
// in the background, and the open thread's wait on it (at most 5s, then
// "Couldn't load messages" + Retry).

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Result } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import type { ChannelSummary } from '@/lib/chat-reads';
import {
  createNotesEnsurer,
  ensureNotesChannel,
  notesSummary,
  waitForNotes,
  type EnsureState,
  type NotesEnsurer,
} from '@/lib/chat/notes';

/** The session's one ensurer: every Chat home mount shares its answers. */
const notesEnsurer: NotesEnsurer = createNotesEnsurer((workspaceId) =>
  ensureNotesChannel(supabase, { workspaceId }),
);

interface UseNotes {
  summary: ChannelSummary;
  /** Where this workspace's ensure stands (the open thread waits on 'pending'). */
  status: EnsureState;
  /** Ensure again (the thread's Retry, opening notes after a failure). */
  retry: () => void;
  /** Ensure (or reuse this session's answer), then run. Never throws. */
  ensured: () => Promise<Result<string>>;
}

export function useNotes(params: {
  workspaceId: string;
  currentUserId: string;
  /** The user's own photo, already in app state (useCurrentProfile); null: the notebook. */
  avatarUrl?: string | null;
  /** Injected in tests; the app uses the session's ensurer. */
  ensurer?: NotesEnsurer;
}): UseNotes {
  const { workspaceId, currentUserId } = params;
  const ensurer = params.ensurer ?? notesEnsurer;
  const avatarUrl = params.avatarUrl ?? null;
  const summary = useMemo(
    () => notesSummary(workspaceId, currentUserId, avatarUrl),
    [workspaceId, currentUserId, avatarUrl],
  );
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; status: EnsureState }>(() => ({
    key: summary.channelId,
    status: ensurer.state(workspaceId, currentUserId) === 'ready' ? 'ready' : 'pending',
  }));
  // Once per workspace per session (the ensurer shares one call); a switch
  // starts the new workspace's. The answer is applied only while it is current.
  useEffect(() => {
    let current = true;
    const key = summary.channelId;
    const known = ensurer.state(workspaceId, currentUserId);
    setState({ key, status: known === 'ready' ? 'ready' : 'pending' });
    void waitForNotes(ensurer.ensure(workspaceId, currentUserId)).then((result) => {
      if (!current) return;
      if (!result.ok) {
        logger.warn('chat: notes ensure failed', {
          workspace_id: workspaceId,
          error: result.error.message,
        });
      }
      setState({ key, status: result.ok ? 'ready' : 'failed' });
    });
    return () => {
      current = false;
    };
  }, [ensurer, workspaceId, currentUserId, summary.channelId, attempt]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const ensured = useCallback(
    () => ensurer.ensure(workspaceId, currentUserId),
    [ensurer, workspaceId, currentUserId],
  );
  return {
    summary,
    status: state.key === summary.channelId ? state.status : 'pending',
    retry,
    ensured,
  };
}
