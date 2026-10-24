// The forward picker: a sheet listing every chat the caller is in (hidden ones
// included, most recent first), a name search, multi-select with checkmarks,
// and a sticky "Send to N chats" footer button disabled at 0. The same visual
// language as NewChatSheet and MemberPicker (Sheet, Input, 44px avatar rows,
// accent-soft selected state). The send runs through the caller's forward
// action; a failure toasts "Could not forward to [chat name]." and keeps the
// sheet open. Design tokens only, so light and dark stay at parity.

import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { NotesAvatar } from '@/components/chat/NotesBits';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { SelectCheck } from '@/components/ui/SelectCheck';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import type { ChannelSummary } from '@/lib/chat-reads';
import { selectConversation } from '@/lib/chat/chat-store';
import {
  forwardFailedMessage,
  forwardPickerChannels,
  sendToLabel,
  toggleForwardTarget,
} from '@/lib/chat/forward';
import { useChatStore } from '@/components/chat/ChatStoreProvider';
import { useHistoryStep } from '@/lib/chat/use-history-step';
import { SHEET_STEP_KEYS } from '@/lib/chat/sheet-steps';

export type ForwardSendResult = { ok: true } | { ok: false; failed: ChannelSummary | null };

interface ForwardPickerProps {
  open: boolean;
  onClose: () => void;
  channels: readonly ChannelSummary[];
  /** Forward to the chosen chats; resolves once every send settled or one failed. */
  onSend: (targets: ChannelSummary[]) => Promise<ForwardSendResult>;
  /** Called after every chat received every message. */
  onSent: () => void;
  /**
   * Push its own history step so system Back closes only the picker (FT40).
   * Off by default: the Tasks sheet's nested picker (X4) closes together with
   * its sheet on send, and two steps popping in one tick leave WebKit's
   * history one entry off, so Back no longer returns to the chat list.
   */
  historyStep?: boolean;
}

/**
 * A picker row's avatar: the notes avatar (own photo + badge, or the
 * notebook) for Personal notes, else the chat's photo or initials. Hook-free.
 */
export function forwardRowAvatar(channel: ChannelSummary, selected: boolean): ReactElement {
  if (channel.channelType === 'notes') {
    return (
      <NotesAvatar
        size="small"
        src={channel.avatarUrl}
        surface={selected ? 'accent-soft' : 'panel'}
        {...(!selected ? { hoverSurface: 'panel-2' as const } : {})}
      />
    );
  }
  return (
    <Avatar
      name={channel.title}
      {...(channel.avatarUrl !== null ? { src: channel.avatarUrl } : {})}
      size="md"
    />
  );
}

export function ForwardPicker(props: ForwardPickerProps): ReactElement {
  const { state } = useChatStore();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // System Back closes only the picker; the chat (or task sheet) under it stays.
  useHistoryStep(props.open && props.historyStep === true, SHEET_STEP_KEYS.forward, props.onClose);

  useEffect(() => {
    if (!props.open) return;
    setSearch('');
    setSelected(new Set());
  }, [props.open]);

  const summaryFor = useCallback(
    (channelId: string) => selectConversation(state, channelId),
    [state],
  );
  const listed = forwardPickerChannels(props.channels, summaryFor, search);

  async function send(): Promise<void> {
    if (busy || selected.size === 0) return;
    const targets = forwardPickerChannels(props.channels, summaryFor, '').filter((c) =>
      selected.has(c.channelId),
    );
    setBusy(true);
    const result = await props.onSend(targets);
    setBusy(false);
    if (result.ok) {
      props.onSent();
      return;
    }
    if (result.failed !== null) toast.show({ title: forwardFailedMessage(result.failed.title) });
  }

  return (
    <Sheet
      open={props.open}
      onClose={() => {
        if (!busy) props.onClose();
      }}
      title="Forward to"
      footer={
        <Button
          variant="primary"
          className="w-full"
          disabled={selected.size === 0 || busy}
          onClick={() => void send()}
        >
          {sendToLabel(selected.size)}
        </Button>
      }
    >
      <Input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search chats"
        aria-label="Search chats"
      />
      {listed.length === 0 ? (
        <p className="px-1 py-3 text-base text-fg-3">
          {search.trim() !== '' ? `No chats called "${search.trim()}"` : 'No chats yet'}
        </p>
      ) : (
        <ul className="mt-3 flex flex-col">
          {listed.map((channel) => {
            const isSelected = selected.has(channel.channelId);
            return (
              <li key={channel.channelId}>
                <PressableRow
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    setSelected((prev) => toggleForwardTarget(prev, channel.channelId))
                  }
                  className={cn(
                    'group/notes-row flex items-center gap-3 px-2 py-1 transition-colors',
                    isSelected ? 'bg-accent-soft text-accent' : 'text-fg-2',
                  )}
                >
                  {forwardRowAvatar(channel, isSelected)}
                  <span className="min-w-0 flex-1 truncate text-base font-medium">
                    {channel.title}
                  </span>
                  <SelectCheck checked={isSelected} />
                </PressableRow>
              </li>
            );
          })}
        </ul>
      )}
    </Sheet>
  );
}
