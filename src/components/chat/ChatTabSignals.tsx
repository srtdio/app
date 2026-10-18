// The chat's tab signals, mounted once inside the shell's ChatStoreProvider:
// the document title carries "(N) " for the total unread across the user's
// chats (the same chat_unread_counts the chat list and Chat-tab badge read; no
// second counter), and a short synthesised tone plays for a live message from
// someone else while the tab is hidden or that chat is not the open one. The
// rules live in notify-sound.ts; this only wires them. Renders nothing.

import { useEffect, useRef } from 'react';
import { useChatStore, useServerNow } from '@/components/chat/ChatStoreProvider';
import { playToneShared, shouldPlayTone, tabTitle } from '@/lib/chat/notify-sound';
import { chatAlertText, pushTabAlert } from '@/lib/tab-alert';

export function ChatTabSignals(): null {
  const { totalUnread, loadStatus, state, subscribeLiveIncoming } = useChatStore();
  // Server time (device clock plus the store's offset): created_at is server time.
  const serverNow = useServerNow();
  const serverNowRef = useRef(serverNow);
  serverNowRef.current = serverNow;

  // "(N) " on the tab title, removed at 0 (and on unmount).
  useEffect(() => {
    document.title = tabTitle(document.title, totalUnread);
  }, [totalUnread]);
  useEffect(() => () => void (document.title = tabTitle(document.title, 0)), []);

  // The list's ready moment: nothing before it tones (initial load).
  const readyAtRef = useRef<number | null>(null);
  if (loadStatus === 'ready') readyAtRef.current ??= serverNow();
  else readyAtRef.current = null;
  const activeRef = useRef(state.activeConversationId);
  activeRef.current = state.activeConversationId;
  const lastToneRef = useRef<number | null>(null);

  useEffect(
    () =>
      subscribeLiveIncoming(({ channelId, createdAt, channelType, title }) => {
        const nowMs = serverNowRef.current();
        const messageAtMs = Date.parse(createdAt);
        const play = shouldPlayTone({
          own: false,
          channelId,
          messageAtMs: Number.isNaN(messageAtMs) ? nowMs : messageAtMs,
          readyAtMs: readyAtRef.current,
          activeChannelId: activeRef.current,
          tabHidden: document.hidden,
          lastToneAtMs: lastToneRef.current,
          nowMs,
        });
        if (!play) return;
        lastToneRef.current = nowMs;
        playToneShared();
        // Background tab: the tab speaks too (who wrote, never the text).
        if (title !== null && channelType !== null && channelType !== 'notes') {
          pushTabAlert({ kind: 'chat', text: chatAlertText(channelType, title) });
        }
      }),
    [subscribeLiveIncoming],
  );

  return null;
}
