// A comment's action bar (Linear style, 8 Nov 2026): a small bordered pill
// that sits ON the comment's top edge, right aligned, half above it, always
// shown on phone and laptop (no hover reveal). Left to right: Reply, Resolve,
// To-do, Edit, a hairline, Delete; src/lib/comment-tasks.ts commentBar decides
// which show (hide what a person can't do). Every icon is a 44 box: the pill
// is 36 tall and the boxes run 4 past it top and bottom, so the hit stays 44
// while the pill reads small. The row it sits on keeps the room above (the
// list's spacing), so it never covers the comment above, a title or a time.
// Pure render: no read, no wait.

import type { ReactElement } from 'react';
import { useInRouterContext, useNavigate } from 'react-router-dom';
import { IconButton } from '@/components/ui/IconButton';
import { PressableRow } from '@/components/ui/PressableRow';
import { Tag } from '@/components/ui/Tag';
import {
  ICON_SIZE,
  IconEdit,
  IconReply,
  IconResolve,
  IconTodo,
  IconTrash,
} from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { barHasButtons, type CommentBar, type TaskTag } from '@/lib/comment-tasks';

/** The pill: 36 tall, hairline frame, the surface behind it so the row's top line stops at its edge. */
export const COMMENT_BAR_CLASS =
  'flex h-9 shrink-0 items-center self-start -translate-y-1/2 rounded-lg border border-border bg-panel';

/** Each 44 box runs 4 past the 36 pill, top and bottom. */
const BAR_BUTTON_CLASS = '-my-1';

/** The resolve slot's word per kind (its accessible name; checkpoints add their number). */
export const REOPEN_LABEL = 'Reopen';
export const RESOLVE_LABEL = 'Resolve';
export const TODO_LABEL = 'To-do';
export const EDIT_LABEL = 'Edit';
export const DELETE_LABEL = 'Delete';
export const REPLY_LABEL = 'Reply';
export const BAR_LABEL = 'Comment actions';

/** Which control the resolve slot is (a plain thread's Resolve / Reopen, a checkpoint's Resolve or Confirm). */
export type ResolveHook =
  | 'data-comment-resolve'
  | 'data-checkpoint-box'
  | 'data-checkpoint-confirm';

export interface CommentActionBarProps {
  bar: CommentBar;
  /** The resolve slot's accessible name ("Resolve", "Resolve checkpoint 2", "Reopen", "Confirm checkpoint 2"). */
  resolveLabel: string;
  /** The resolve slot's data hook (tests, the tour): which control it is. */
  resolveHook: ResolveHook;
  resolveBusy?: boolean;
  /** The row's reply composer is open (the Reply tap then asks to discard or closes it). */
  replyOpen?: boolean;
  /** The onboarding guide's anchor on the Reply it teaches. */
  replyInduction?: string | undefined;
  /** A reply's Reply aims at that reply's author. */
  replyToReply?: boolean;
  onReply: () => void;
  onResolve: () => void;
  onTodo: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

type ResolveHookProps =
  | { 'data-comment-resolve': '' }
  | { 'data-checkpoint-box': '' }
  | { 'data-checkpoint-confirm': '' };

/** The resolve slot's data hook as a prop. Pure. */
function resolveHookProps(hook: ResolveHook): ResolveHookProps {
  if (hook === 'data-checkpoint-box') return { 'data-checkpoint-box': '' };
  if (hook === 'data-checkpoint-confirm') return { 'data-checkpoint-confirm': '' };
  return { 'data-comment-resolve': '' };
}

export function CommentActionBar(props: CommentActionBarProps): ReactElement | null {
  const { bar } = props;
  if (!barHasButtons(bar)) return null;
  const resolved = bar.resolve === 'reopen';
  return (
    <div role="toolbar" aria-label={BAR_LABEL} data-comment-bar="" className={COMMENT_BAR_CLASS}>
      {bar.reply ? (
        <IconButton
          type="button"
          label={REPLY_LABEL}
          data-row-action="reply"
          data-bar-action="reply"
          {...(props.replyToReply === true ? { 'data-reply-to-reply': '' } : {})}
          {...(props.replyInduction !== undefined
            ? { 'data-induction': props.replyInduction }
            : {})}
          aria-expanded={props.replyOpen === true}
          className={BAR_BUTTON_CLASS}
          onClick={props.onReply}
        >
          <IconReply size={ICON_SIZE.inline} />
        </IconButton>
      ) : null}
      {bar.resolve !== null ? (
        <IconButton
          type="button"
          label={props.resolveLabel}
          data-bar-action="resolve"
          {...resolveHookProps(props.resolveHook)}
          {...(bar.resolve === 'reopen' ? { 'aria-pressed': true } : {})}
          aria-busy={props.resolveBusy === true ? true : undefined}
          disabled={props.resolveBusy === true}
          // Reopen (a resolved thread) and Confirm read in the good token; Resolve in ink.
          className={cn(
            BAR_BUTTON_CLASS,
            (resolved || bar.resolve === 'confirm') && 'text-good hover:text-good',
          )}
          onClick={props.onResolve}
        >
          <IconResolve size={ICON_SIZE.inline} />
        </IconButton>
      ) : null}
      {bar.todo ? (
        <IconButton
          type="button"
          label={TODO_LABEL}
          data-bar-action="todo"
          className={BAR_BUTTON_CLASS}
          onClick={props.onTodo}
        >
          <IconTodo size={ICON_SIZE.inline} />
        </IconButton>
      ) : null}
      {bar.edit ? (
        <IconButton
          type="button"
          label={EDIT_LABEL}
          data-bar-action="edit"
          className={BAR_BUTTON_CLASS}
          onClick={props.onEdit}
        >
          <IconEdit size={ICON_SIZE.inline} />
        </IconButton>
      ) : null}
      {bar.delete ? (
        <>
          {bar.reply || bar.resolve !== null || bar.todo || bar.edit ? (
            <span aria-hidden="true" data-bar-divider="" className="h-5 border-l border-border" />
          ) : null}
          <IconButton
            type="button"
            label={DELETE_LABEL}
            data-bar-action="delete"
            className={cn(BAR_BUTTON_CLASS, 'text-bad hover:text-bad')}
            onClick={props.onDelete}
          >
            <IconTrash size={ICON_SIZE.inline} />
          </IconButton>
        </>
      ) : null}
    </div>
  );
}

/**
 * The one grey tag under a comment with a task (ui/Tag; "Task done ..." in the
 * good token). Agency: a tap opens that chat's Tasks sheet scrolled to the
 * task (chatTaskHref, handled by the chat). A client's tag is static. Outside
 * a router (isolated mounts) it is static too.
 */
export function CommentTaskTag(props: { tag: TaskTag }): ReactElement {
  const routed = useInRouterContext();
  const tag = <Tag label={props.tag.text} tone={props.tag.tone} />;
  if (props.tag.href === null || !routed) {
    return (
      <div data-comment-task-tag="" className="mt-3 flex">
        {tag}
      </div>
    );
  }
  return <TaskTagLink tag={props.tag} href={props.tag.href} />;
}

function TaskTagLink(props: { tag: TaskTag; href: string }): ReactElement {
  const navigate = useNavigate();
  return (
    // The 44 hit box puts the tag 12 under the body, as the static tag, and
    // stays whole in the flow so the next comment's bar never meets it.
    <div data-comment-task-tag="" className="flex">
      <PressableRow
        inline
        type="button"
        data-comment-task-open=""
        aria-label={`${props.tag.text}. Open in Tasks`}
        onClick={() => navigate(props.href)}
        className="flex min-h-11 items-center"
      >
        <Tag label={props.tag.text} tone={props.tag.tone} />
      </PressableRow>
    </div>
  );
}
