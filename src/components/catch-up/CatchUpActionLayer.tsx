// Catch up's one message action layer (10 Nov 2026, Slack's way): the same
// actions on a message or comment wherever it shows. The thread sheet's strip
// keys (to-do, forward, more) and a long-press (right-click on a laptop) on a
// row open the existing sheets: chat's Add to Tasks (TaskSheet), the Forward
// picker, the long-press sheet (MessageActionMenu); a comment's To-do opens
// CommentTaskSheet. Nothing is read on a tap: the sheets mount only while open
// and read what they always read. Read only: no edit, no delete here.

import { useState } from 'react';
import type { ReactElement } from 'react';
import { supabase } from '@/lib/supabase';
import { generateTraceId } from '@/lib/trace';
import { copyText, COPY_FAILED } from '@/lib/clipboard';
import { useOptionalToast } from '@/components/ui/toast';
import { useRosterSafe } from '@/components/ui/use-open-person-dm';
import { MessageActionMenu } from '@/components/chat/MessageActionMenu';
import { ForwardPicker, type ForwardSendResult } from '@/components/chat/ForwardPicker';
import { TaskSheet } from '@/components/chat/tasks/TaskSheet';
import { useChatTasks } from '@/components/chat/tasks/useChatTasks';
import { CommentTaskSheet } from '@/components/comments/CommentTaskSheet';
import type { RootActions } from '@/components/chat/ThreadRail';
import { forwardMessagesByIds } from '@/lib/chat/forward-by-ids';
import { forwardRecordInput, runForward } from '@/lib/chat/forward';
import { sendMessageRecord } from '@/lib/chat/record';
import { newMessageId } from '@/lib/chat/message-id';
import { targetFromSummary } from '@/lib/chat/thread';
import type { ChannelSummary } from '@/lib/chat-reads';
import type { ViewerSide } from '@/lib/chat/viewer-role';
import { taskTitleFrom } from '@/lib/comment-tasks';
import { useMentionCandidates } from '@/lib/workspace-members';
import { useWorkspace } from '@/lib/workspace-context';
import { safeTimeZone } from '@/lib/time';
import type { CatchUpItem } from '@/lib/catch-up/queue';
import type { CatchUpMessageRow } from '@/lib/catch-up/body';

/** What a message's actions act on: the row and the card it sits on. */
export interface CatchUpActionTarget {
  item: CatchUpItem;
  row: CatchUpMessageRow;
}

type Open =
  | { kind: 'more'; target: CatchUpActionTarget; rect: DOMRect }
  | { kind: 'tasks' | 'forward'; target: CatchUpActionTarget }
  | null;

const isChat = (item: CatchUpItem): boolean =>
  item.kind === 'chat-main' || item.kind === 'chat-thread';

/** Which keys a row offers (hide what a person can't do). Pure. */
export function actionKeysOf(
  target: CatchUpActionTarget,
  roster: readonly Pick<ChannelSummary, 'channelId'>[],
): { tasks: boolean; forward: boolean } {
  const { item, row } = target;
  const text = row.text.trim() !== '';
  if (isChat(item))
    return { tasks: text && roster.some((c) => c.channelId === item.entityId), forward: true };
  // Comments on posts and briefs make a task; plan and idea comments have none.
  return { tasks: text && (item.kind === 'post' || item.kind === 'brief'), forward: text };
}

/** One forwarded copy per chat: the chat message itself (by id), or a comment's text. */
async function forwardTarget(
  target: CatchUpActionTarget,
  currentUserId: string,
  chats: ChannelSummary[],
): Promise<ForwardSendResult> {
  const sent = (ok: boolean): { ok: true } | { ok: false; message: string } =>
    ok ? { ok: true } : { ok: false, message: 'Not sent' };
  if (isChat(target.item)) {
    return forwardMessagesByIds({
      client: supabase,
      currentUserId,
      messageIds: [target.row.id],
      targets: chats,
      forward: async (messages, to) => {
        const res = await runForward({
          targets: to,
          messages,
          sendOne: async (chat, m) =>
            sent(
              (
                await sendMessageRecord({
                  client: supabase,
                  ...forwardRecordInput(m, {
                    id: newMessageId(),
                    channelId: chat.channelId,
                    traceId: generateTraceId(),
                  }),
                })
              ).ok,
            ),
        });
        return res.ok ? { ok: true } : { ok: false, failed: res.failed };
      },
    });
  }
  for (const chat of chats) {
    const res = await sendMessageRecord({
      client: supabase,
      id: newMessageId(),
      channelId: chat.channelId,
      traceId: generateTraceId(),
      body: target.row.text,
      attachmentAssetIds: [],
    });
    if (!res.ok) return { ok: false, failed: chat };
  }
  return { ok: true };
}

/** Chat's Add to Tasks: the chat's own TaskSheet holding the message text (mounted while open). */
function ChatTasks(props: {
  channel: ChannelSummary;
  currentUserId: string;
  side: ViewerSide;
  prefill: string;
  timeZone: string | undefined;
  onClose: () => void;
}): ReactElement {
  const { workspaceId, workspaces } = useWorkspace();
  const tasks = useChatTasks({
    channelId: props.channel.channelId,
    currentUserId: props.currentUserId,
    target: targetFromSummary(props.channel),
    profiles: new Map(),
  });
  return (
    <TaskSheet
      open
      onClose={props.onClose}
      tasks={tasks}
      currentUserId={props.currentUserId}
      side={props.side === 'unknown' ? null : props.side}
      seenMs={null}
      focusTaskId={null}
      prefill={props.prefill}
      timeZone={safeTimeZone(props.timeZone)}
      weekStartDay={workspaces.find((w) => w.id === workspaceId)?.week_start_day ?? 1}
    />
  );
}

/** A comment's To-do: the comments screen's own sheet (mounted while open). */
function CommentTasks(props: {
  workspaceId: string;
  commentId: string;
  text: string;
  currentUserId: string;
  onClose: () => void;
}): ReactElement {
  const { candidates } = useMentionCandidates(props.workspaceId);
  return (
    <CommentTaskSheet
      open
      onClose={props.onClose}
      workspaceId={props.workspaceId}
      commentId={props.commentId}
      initialTitle={taskTitleFrom(props.text)}
      me={props.currentUserId}
      candidates={candidates}
      newTrace={generateTraceId}
      onCreated={() => undefined}
      onExists={() => undefined}
    />
  );
}

export function useCatchUpActions(input: {
  workspaceId: string;
  currentUserId: string;
  side: ViewerSide;
  timeZone: string | undefined;
  /** The card's place link (the menu's Copy link); null: none. */
  linkOf: (item: CatchUpItem) => string | null;
}): {
  rootActions: (target: CatchUpActionTarget) => RootActions;
  hold: (target: CatchUpActionTarget, from: HTMLElement) => void;
  layer: ReactElement;
} {
  const roster = useRosterSafe();
  const toast = useOptionalToast();
  const [open, setOpen] = useState<Open>(null);
  const close = (): void => setOpen(null);
  const hold = (target: CatchUpActionTarget, from: HTMLElement): void =>
    setOpen({ kind: 'more', target, rect: from.getBoundingClientRect() });
  const rootActions = (target: CatchUpActionTarget): RootActions => {
    const keys = actionKeysOf(target, roster);
    return {
      ...(keys.tasks ? { onTasks: () => setOpen({ kind: 'tasks', target }) } : {}),
      ...(keys.forward ? { onForward: () => setOpen({ kind: 'forward', target }) } : {}),
      onMore: (from: HTMLElement) => hold(target, from),
    };
  };
  const t = open?.target ?? null;
  const keys = t !== null ? actionKeysOf(t, roster) : { tasks: false, forward: false };
  const channel = t !== null ? roster.find((c) => c.channelId === t.item.entityId) : undefined;
  const link = t !== null ? input.linkOf(t.item) : null;
  const copied = (ok: boolean, word: string): void => {
    toast?.show(ok ? { title: `${word} copied` } : { title: COPY_FAILED, tone: 'error' });
  };
  const layer = (
    <>
      <MessageActionMenu
        open={open?.kind === 'more'}
        onClose={close}
        anchor={open?.kind === 'more' ? open.rect : null}
        mine={t?.row.author.id === input.currentUserId}
        currentReaction={null}
        canReact={false}
        onReact={() => undefined}
        canReply={false}
        onReply={() => undefined}
        canCopy={t !== null && t.row.text.trim() !== ''}
        onCopy={() => {
          if (t !== null)
            void copyText(t.row.text).then((ok) =>
              copied(ok, isChat(t.item) ? 'Message' : 'Comment'),
            );
        }}
        canForward={keys.forward}
        onForward={() => {
          if (t !== null) setOpen({ kind: 'forward', target: t });
        }}
        canAddToTasks={keys.tasks}
        onAddToTasks={() => {
          if (t !== null) setOpen({ kind: 'tasks', target: t });
        }}
        canCopyLink={link !== null}
        onCopyLink={() => {
          if (link !== null)
            void copyText(`${window.location.origin}${link}`).then((ok) => copied(ok, 'Link'));
        }}
      />
      {open?.kind === 'forward' ? (
        <ForwardPicker
          historyStep
          open
          onClose={close}
          channels={roster}
          onSend={(chats) => forwardTarget(open.target, input.currentUserId, chats)}
          onSent={close}
        />
      ) : null}
      {open?.kind === 'tasks' && isChat(open.target.item) && channel !== undefined ? (
        <ChatTasks
          channel={channel}
          currentUserId={input.currentUserId}
          side={input.side}
          prefill={taskTitleFrom(open.target.row.text)}
          timeZone={input.timeZone}
          onClose={close}
        />
      ) : null}
      {open?.kind === 'tasks' && !isChat(open.target.item) ? (
        <CommentTasks
          workspaceId={input.workspaceId}
          commentId={open.target.row.id}
          text={open.target.row.text}
          currentUserId={input.currentUserId}
          onClose={close}
        />
      ) : null}
    </>
  );
  return { rootActions, hold, layer };
}
