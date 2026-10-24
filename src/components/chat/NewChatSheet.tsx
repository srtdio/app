import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { IconChat, IconUser } from '@/components/ui/icons';
import type { DomainError } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useNewTrace } from '@/lib/trace-context';
import { createGroupChannel, startDmChannel } from '@/components/chat/chat-actions';
import { MemberPicker } from '@/components/chat/MemberPicker';
import { excludeMembers } from '@/components/chat/member-picker';
import { useWorkspaceMembers } from '@/components/chat/use-workspace-members';

interface NewChatSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  currentUserId: string;
  /** Called with the ensured DM channel id; the parent refreshes and opens it. */
  onDmReady: (channelId: string) => void;
  /**
   * Called after a group is created with its id and the members it was created
   * with; the parent refreshes the channel list and tells those members.
   */
  onGroupCreated: (groupId: string, memberUserIds: string[]) => void;
}

type Mode = 'choose' | 'dm' | 'group';

/** The sheet's failure lines; the raw error goes to the logger only. */
export const NEW_DM_FAILED = "Couldn't start the chat, try again";
export const NEW_GROUP_FAILED = "Couldn't create the group, try again";

/** Discard confirm while a group name is typed or anyone is picked (FB3). */
export const NEW_CHAT_DISCARD = {
  title: 'Discard this chat?',
  message: 'Your group name and picked people will be lost.',
};

/** Inline reasons a tap on Start chat / Create group cannot go yet (FT47). */
export const PICK_SOMEONE = 'Pick at least one person';
export const NAME_THE_GROUP = 'Name the group';

/** Whether the sheet holds input worth a discard confirm. Pure. */
export function newChatDirty(state: {
  name: string;
  selectedIds: readonly string[];
  peerId: string | null;
}): boolean {
  return state.name.trim() !== '' || state.selectedIds.length > 0 || state.peerId !== null;
}

/** Why the primary action cannot run yet, or null when it can. Pure. */
export function newChatMissing(
  mode: 'dm' | 'group',
  state: { name: string; selectedIds: readonly string[]; peerId: string | null },
): string | null {
  if (mode === 'dm') return state.peerId === null ? PICK_SOMEONE : null;
  if (state.name.trim() === '') return NAME_THE_GROUP;
  if (state.selectedIds.length === 0) return PICK_SOMEONE;
  return null;
}

/** Log a failed DM ensure or group create and return its fixed copy. */
export function newChatFailureCopy(kind: 'dm' | 'group', failure: DomainError): string {
  logger.warn(kind === 'dm' ? 'chat: dm start failed' : 'chat: group create failed', {
    code: failure.code,
    error: failure.message,
  });
  return kind === 'dm' ? NEW_DM_FAILED : NEW_GROUP_FAILED;
}

/**
 * The "New chat" entry point: choose between a new DM or a new group, then pick
 * the people. DM ensures the one-to-one channel and opens it; group creates the
 * channel with all chosen members in a single call. Domain failures surface
 * inline and never throw.
 */
export function NewChatSheet(props: NewChatSheetProps): ReactElement {
  const newTrace = useNewTrace();
  const members = useWorkspaceMembers(props.workspaceId);

  const [mode, setMode] = useState<Mode>('choose');
  const [peerId, setPeerId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The reason a tap on the primary action could not go (cleared on any edit).
  const [missing, setMissing] = useState<string | null>(null);

  // Reset to a clean state every time the sheet opens.
  useEffect(() => {
    if (props.open) {
      setMode('choose');
      setPeerId(null);
      setName('');
      setSelectedIds([]);
      setBusy(false);
      setError(null);
      setMissing(null);
    }
  }, [props.open]);

  // Any edit clears the inline reason; the next tap re-checks.
  useEffect(() => setMissing(null), [name, selectedIds, peerId, mode]);
  const dirty = newChatDirty({ name, selectedIds, peerId });

  // The current user can never be their own DM peer or a group co-member of self.
  const options = excludeMembers(members.options, [props.currentUserId]);

  function toggleSelected(userId: string): void {
    setSelectedIds((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  }

  async function submitDm(): Promise<void> {
    if (busy) return;
    const reason = newChatMissing('dm', { name, selectedIds, peerId });
    if (reason !== null || peerId === null) {
      setMissing(reason ?? PICK_SOMEONE);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await startDmChannel(
      supabase,
      { workspaceId: props.workspaceId, peerUserId: peerId, traceId: newTrace() },
      props.onDmReady,
    );
    setBusy(false);
    if (failure !== null) setError(newChatFailureCopy('dm', failure));
  }

  async function submitGroup(): Promise<void> {
    const trimmed = name.trim();
    if (busy) return;
    const reason = newChatMissing('group', { name, selectedIds, peerId });
    if (reason !== null) {
      setMissing(reason);
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await createGroupChannel(
      supabase,
      {
        workspaceId: props.workspaceId,
        name: trimmed,
        memberUserIds: selectedIds,
        traceId: newTrace(),
      },
      (groupId) => props.onGroupCreated(groupId, selectedIds),
    );
    setBusy(false);
    if (failure !== null) setError(newChatFailureCopy('group', failure));
  }

  const title = mode === 'group' ? 'New group' : mode === 'dm' ? 'New direct message' : 'New chat';
  const errorBanner =
    error !== null ? (
      <div
        role="alert"
        className="mb-3 rounded-xl border border-bad bg-bad-soft px-4 py-3 text-legacy-sm text-bad"
      >
        {error}
      </div>
    ) : null;

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title={title}
      footer={footer()}
      dirty={dirty}
      discard={NEW_CHAT_DISCARD}
      busy={busy}
      busyLabel={mode === 'dm' ? 'Starting…' : 'Creating…'}
    >
      {errorBanner}
      {body()}
    </Sheet>
  );

  function footer(): ReactElement | undefined {
    if (mode === 'choose') return undefined;
    if (mode === 'dm') {
      return (
        <>
          <Button disabled={busy} onClick={() => setMode('choose')}>
            Back
          </Button>
          {missingLine()}
          <Button
            variant="primary"
            className={missing === null ? 'ml-auto' : undefined}
            disabled={busy}
            onClick={() => void submitDm()}
          >
            {busy ? 'Starting' : 'Start chat'}
          </Button>
        </>
      );
    }
    return (
      <>
        <Button disabled={busy} onClick={() => setMode('choose')}>
          Back
        </Button>
        {missingLine()}
        <Button
          variant="primary"
          className={missing === null ? 'ml-auto' : undefined}
          disabled={busy}
          onClick={() => void submitGroup()}
        >
          {busy ? 'Creating' : 'Create group'}
        </Button>
      </>
    );
  }

  function missingLine(): ReactElement | null {
    if (missing === null) return null;
    return (
      <p
        data-new-chat-missing=""
        role="alert"
        className="ml-auto text-right text-legacy-sm text-bad"
      >
        {missing}
      </p>
    );
  }

  function body(): ReactElement {
    if (mode === 'choose') {
      return (
        <div className="flex flex-col gap-2">
          <Button className="!justify-start" onClick={() => setMode('dm')}>
            <IconUser size={16} />
            New direct message
          </Button>
          <Button className="!justify-start" onClick={() => setMode('group')}>
            <IconChat size={16} />
            New group
          </Button>
        </div>
      );
    }
    if (mode === 'dm') {
      return (
        <MemberPicker
          options={options}
          selectedIds={peerId !== null ? [peerId] : []}
          onToggle={(id) => setPeerId((prev) => (prev === id ? null : id))}
          loading={members.loading}
          error={members.error}
          emptyLabel="No one else is in this workspace yet."
        />
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <Field label="Group name" htmlFor="new-group-name" required>
          <Input
            id="new-group-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Campaign team"
            aria-label="Group name"
          />
        </Field>
        <div>
          <p className="mb-1.5 text-legacy-sm font-medium">Members</p>
          <MemberPicker
            options={options}
            selectedIds={selectedIds}
            onToggle={toggleSelected}
            loading={members.loading}
            error={members.error}
            emptyLabel="No one else is in this workspace yet."
          />
        </div>
      </div>
    );
  }
}
