// A comment's To-do: the "New task" sheet (8 Nov 2026). The field opens with
// the comment's plain text (no format marks, editable, at most 200), Add sits
// in the header (busy keeps its width). One pick of who it goes to: People
// (agency-side members only, never a client, plus Me; the search opens the
// palette in pick mode) or Groups (the viewer's group chats). Under them the
// chat task sheet's own priority chip (P1 by default) and the shared date
// picker ("Add date").
//
// The target chat: a person -> my DM with them (the person card's Message
// path: the cached DM, else dm_channel_ensure), Me -> my Personal notes
// (this session's notes ensure), a group -> its chat. Nothing is read while
// the sheet paints: people come from the members the page already holds, groups
// from the device's chat list. The one write is comment_task_create; a failure
// reads "Couldn't add the task. {reason}" in the sheet, task_exists refreshes
// the comment (someone else just added one).

import { useState, type ReactElement } from 'react';
import type { CommentTaskEmbed } from '@srtdio/comments';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { DatePicker } from '@/components/ui/DatePicker';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { Text } from '@/components/ui/Text';
import { useResolvePersonDm, useRosterSafe } from '@/components/ui/use-open-person-dm';
import { PriorityChip } from '@/components/chat/tasks/TaskRow';
import { PalettePickButton } from '@/components/shell/CommandPalette';
import { DEFAULT_PRIORITY, TASK_TITLE_MAX, type TaskPriority } from '@/lib/chat/tasks';
import { ensureSessionNotes } from '@/lib/chat/use-notes';
import {
  ADD_DATE_LABEL,
  ADD_LABEL,
  GROUPS_LABEL,
  ME_LABEL,
  NEW_TASK_TITLE,
  PEOPLE_CHIPS_MAX,
  PEOPLE_LABEL,
  SEARCH_PEOPLE_LABEL,
  TASK_FIELD_LABEL,
  addTaskFailed,
  createCommentTask,
  localTaskLink,
  sameTarget,
  taskChannelId,
  taskGroups,
  taskPeople,
  taskRoute,
  type TaskTarget,
} from '@/lib/comment-tasks';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import type { MentionCandidate } from '@/lib/workspace-members';

export interface CommentTaskSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  commentId: string;
  /** The comment's plain text, already one line and capped (taskTitleFrom). */
  initialTitle: string;
  me: string | null;
  /** The workspace members the page already holds (no read here). */
  candidates: readonly MentionCandidate[];
  /** The page's trace source: one new trace per action. */
  newTrace: () => string;
  /** The task landed: the comment paints its tag at once. */
  onCreated: (link: CommentTaskEmbed) => void;
  /** Someone added a task first: the comment re-reads. */
  onExists: () => void;
}

export function CommentTaskSheet(props: CommentTaskSheetProps): ReactElement {
  const roster = useRosterSafe();
  const resolveDm = useResolvePersonDm();
  const [title, setTitle] = useState(props.initialTitle);
  const [target, setTarget] = useState<TaskTarget | null>(null);
  const [priority, setPriority] = useState<TaskPriority>(DEFAULT_PRIORITY);
  const [dueOn, setDueOn] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const people = taskPeople(props.candidates, props.me);
  const groups = taskGroups(roster);
  // A person picked through the search but not among the first chips keeps a chip.
  const shownPeople = people.slice(0, PEOPLE_CHIPS_MAX);
  const extra =
    target?.kind === 'person' && !shownPeople.some((p) => p.id === target.userId)
      ? people.find((p) => p.id === target.userId)
      : undefined;
  const shownGroups =
    target?.kind === 'group' && !groups.some((g) => g.channelId === target.channelId)
      ? [...groups, { channelId: target.channelId, name: target.name }]
      : groups;

  const blank = title.trim() === '';
  const canAdd = !blank && target !== null && !busy;

  function pick(next: TaskTarget): void {
    setError(null);
    setTarget((prev) => (sameTarget(prev, next) ? null : next));
  }

  async function add(): Promise<void> {
    if (!canAdd || target === null) return;
    setBusy(true);
    setError(null);
    const traceId = props.newTrace();
    const route = taskRoute(target, { me: props.me, workspaceId: props.workspaceId, roster });
    const channelId = await taskChannelId(route, {
      ensureDm: resolveDm,
      ensureNotes: async () => {
        if (props.me === null) return null;
        const result = await ensureSessionNotes(props.workspaceId, props.me);
        return result.ok ? result.data : null;
      },
    });
    if (channelId === null) {
      setBusy(false);
      setError(addTaskFailed(null));
      return;
    }
    const result = await createCommentTask({
      client: supabase,
      commentId: props.commentId,
      channelId,
      title,
      priority,
      dueOn: dueOn === '' ? null : dueOn,
      traceId,
    });
    setBusy(false);
    if (result.ok) {
      props.onCreated(localTaskLink(target, props.me, channelId, result.taskId));
      props.onClose();
      return;
    }
    logger.warn('comments: task create failed', { trace_id: traceId, error: result.message });
    if (result.exists) {
      props.onExists();
      props.onClose();
      return;
    }
    setError(addTaskFailed(result.message));
  }

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={NEW_TASK_TITLE}
      busy={busy}
      busyLabel="Adding…"
      headerAction={
        <Button
          type="button"
          variant="primary"
          data-comment-task-add=""
          busy={busy}
          disabled={!canAdd && !busy}
          onClick={() => void add()}
        >
          {ADD_LABEL}
        </Button>
      }
    >
      <div data-comment-task-sheet="" className="flex flex-col gap-4 px-4 pb-4 pt-2">
        <Input
          type="text"
          aria-label={TASK_FIELD_LABEL}
          data-comment-task-title=""
          value={title}
          maxLength={TASK_TITLE_MAX}
          enterKeyHint="done"
          autoComplete="off"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void add();
          }}
        />

        <div className="flex flex-col gap-2">
          <Text role="section" as="h3">
            {PEOPLE_LABEL}
          </Text>
          <div
            role="group"
            aria-label={PEOPLE_LABEL}
            data-comment-task-people=""
            className="flex flex-wrap items-center gap-2"
          >
            {props.me !== null ? (
              <Chip
                label={ME_LABEL}
                selected={target?.kind === 'me'}
                data-task-target="me"
                onClick={() => pick({ kind: 'me' })}
              />
            ) : null}
            {[...shownPeople, ...(extra !== undefined ? [extra] : [])].map((person) => (
              <Chip
                key={person.id}
                label={person.firstName}
                aria-label={person.name}
                selected={target?.kind === 'person' && target.userId === person.id}
                data-task-target={person.id}
                onClick={() => pick({ kind: 'person', userId: person.id })}
              />
            ))}
            <PalettePickButton
              label={SEARCH_PEOPLE_LABEL}
              request={() => ({
                pickKinds: ['person', 'chat_group'],
                multi: false,
                verb: 'Add',
                label: PEOPLE_LABEL,
                onPick: (hits) => {
                  const hit = hits[0];
                  if (hit === undefined) return;
                  if (hit.kind === 'person') {
                    if (hit.id === props.me) pick({ kind: 'me' });
                    // Agency side only: a client picked in the palette is not a task target.
                    else if (people.some((p) => p.id === hit.id)) {
                      pick({ kind: 'person', userId: hit.id });
                    }
                  } else if (hit.kind === 'chat_group' && hit.channelId !== null) {
                    pick({ kind: 'group', channelId: hit.channelId, name: hit.title });
                  }
                },
              })}
            />
          </div>
        </div>

        {shownGroups.length > 0 ? (
          <div className="flex flex-col gap-2">
            <Text role="section" as="h3">
              {GROUPS_LABEL}
            </Text>
            <div
              role="group"
              aria-label={GROUPS_LABEL}
              data-comment-task-groups=""
              className="flex flex-wrap items-center gap-2"
            >
              {shownGroups.map((group) => (
                <Chip
                  key={group.channelId}
                  label={group.name}
                  selected={target?.kind === 'group' && target.channelId === group.channelId}
                  data-task-target={group.channelId}
                  onClick={() =>
                    pick({ kind: 'group', channelId: group.channelId, name: group.name })
                  }
                />
              ))}
            </div>
          </div>
        ) : null}

        <div data-comment-task-meta="" className="flex flex-wrap items-center gap-2">
          <PriorityChip
            priority={priority}
            onPick={setPriority}
            label={`New task priority P${priority}`}
            disabled={busy}
          />
          <DatePicker
            value={dueOn}
            label="Due date"
            placeholder={ADD_DATE_LABEL}
            disablePast
            actions
            onChange={setDueOn}
          />
        </div>

        {error !== null ? <ErrorNote>{error}</ErrorNote> : null}
      </div>
    </Sheet>
  );
}
