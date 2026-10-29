import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { PressableRow } from '@/components/ui/PressableRow';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { ICON_SIZE, IconChat, IconUser } from '@/components/ui/icons';
import type { DomainError } from '@srtdio/rpc';
import { supabase } from '@/lib/supabase';
import { logger } from '@/lib/logger';
import { useNewTrace } from '@/lib/trace-context';
import { createGroupChannel, startDmChannel } from '@/components/chat/chat-actions';
import { MemberPicker } from '@/components/chat/MemberPicker';
import { excludeMembers } from '@/components/chat/member-picker';
import { useWorkspaceMembers, withMembersLoadCopy } from '@/lib/workspace-members';
import { isGroupLimitError, useWorkspace } from '@/lib/workspace-context';
import { dropCachedCapability, useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { moreGroupsRequest } from '@/lib/support';
import { SupportRows } from '@/components/support/SupportRows';
import { ContactSheet } from '@/components/support/ContactSheet';
import { BookCallSheet } from '@/components/support/BookCallSheet';

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
export const NEW_DM_FAILED = "Couldn't start the chat. Try again.";
export const NEW_GROUP_FAILED = "Couldn't create the group. Try again.";

/** Discard confirm while a group name is typed or anyone is picked (FB3). */
export const NEW_CHAT_DISCARD = {
  title: 'Discard this chat?',
  message: 'Your group name and picked people will be lost.',
};

/** Inline reasons a tap on Start chat / Create group cannot go yet (FT47). */
export const PICK_SOMEONE = 'Pick at least one person';
export const NAME_THE_GROUP = 'Name the group';

/** The capability that says this workspace may add another chat group. */
export const GROUP_CREATE_MORE = 'group.create_more';

/** The blocked New group note for the workspace owner; Contact us and Book a call follow. */
export const GROUP_LIMIT_OWNER =
  'On the free plan a workspace has one group. Need another? Talk to us.';

/** Who a member asks when the owner's name is not in the members cache. */
export const GROUP_LIMIT_OWNER_FALLBACK = 'the workspace owner';

/** The blocked New group note for anyone but the owner. */
export function groupLimitMemberCopy(ownerName: string | null): string {
  const who =
    ownerName !== null && ownerName.trim() !== '' ? ownerName : GROUP_LIMIT_OWNER_FALLBACK;
  return `This workspace has one group. Ask ${who} about adding more.`;
}

/**
 * Whether New group is blocked: the cached capability says no, or the server
 * refused a create in this workspace. null (not read yet) and true leave it open.
 */
export function newGroupBlocked(canCreateMore: boolean | null, serverRefused: boolean): boolean {
  return canCreateMore === false || serverRefused;
}

/**
 * The capability answer and the active workspace's owner, from what the session
 * already holds (no read, no await). Isolated renders without a
 * WorkspaceProvider (useWorkspace throws there) read as unknown: New group
 * stays open, as before this rule.
 */
function useGroupLimit(): {
  canCreateMore: boolean | null;
  ownerUserId: string | null;
  workspaceName: string;
} {
  const workspace = useOptionalWorkspace();
  const canCreateMore = useOptionalCapability(GROUP_CREATE_MORE);
  if (workspace === null) return { canCreateMore: null, ownerUserId: null, workspaceName: '' };
  const row = workspace.workspaces.find((w) => w.id === workspace.workspaceId);
  return {
    canCreateMore,
    ownerUserId: row?.owner_user_id ?? null,
    workspaceName: workspace.workspaceDisplayName ?? '',
  };
}

function useOptionalWorkspace(): ReturnType<typeof useWorkspace> | null {
  try {
    return useWorkspace();
  } catch {
    return null;
  }
}

function useOptionalCapability(capability: string): boolean | null {
  try {
    return useWorkspaceCapability(capability);
  } catch {
    return null;
  }
}

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
  const members = withMembersLoadCopy(useWorkspaceMembers(props.workspaceId));
  const limit = useGroupLimit();
  // The workspace whose group_create the server refused (group_limit_reached).
  const [refusedIn, setRefusedIn] = useState<string | null>(null);
  // Contact us / Book a call replace this sheet: one sheet at a time.
  const [support, setSupport] = useState<'contact' | 'book' | null>(null);
  // The two support sheets mount on first use only: chat home paints as before.
  const [supportMounted, setSupportMounted] = useState(false);
  const blocked = newGroupBlocked(limit.canCreateMore, refusedIn === props.workspaceId);
  const isOwner = limit.ownerUserId !== null && limit.ownerUserId === props.currentUserId;

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
    if (failure === null) return;
    if (isGroupLimitError(failure.message)) {
      // Server backstop: show the blocked choose state, and forget only this
      // capability so the next open answers from the cache correctly.
      logger.info('chat: group create refused by group limit', { code: failure.code });
      dropCachedCapability(props.currentUserId, props.workspaceId, GROUP_CREATE_MORE);
      setRefusedIn(props.workspaceId);
      setName('');
      setSelectedIds([]);
      setMode('choose');
      return;
    }
    setError(newChatFailureCopy('group', failure));
  }

  function openSupport(next: 'contact' | 'book'): void {
    props.onClose();
    setSupportMounted(true);
    setSupport(next);
  }

  const title = mode === 'group' ? 'New group' : mode === 'dm' ? 'New direct message' : 'New chat';
  const errorBanner =
    error !== null ? (
      <div
        role="alert"
        className="mb-3 rounded-xl border border-bad bg-bad-soft px-4 py-3 text-base text-bad"
      >
        {error}
      </div>
    ) : null;

  return (
    <>
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
      {supportMounted ? (
        <>
          <ContactSheet
            open={support === 'contact'}
            onClose={() => setSupport(null)}
            workspaceName={limit.workspaceName}
            request={moreGroupsRequest(limit.workspaceName)}
          />
          <BookCallSheet
            open={support === 'book'}
            onClose={() => setSupport(null)}
            workspaceId={props.workspaceId}
          />
        </>
      ) : null}
    </>
  );

  function ownerName(): string | null {
    if (limit.ownerUserId === null) return null;
    // The members cache the comment author names read from; no new read.
    const name = members.profiles.get(limit.ownerUserId)?.displayName;
    return name ?? null;
  }

  function groupLimitNote(): ReactElement {
    return (
      <>
        <p
          id="group-limit-note"
          data-group-limit-note=""
          className="px-1 text-base leading-snug text-fg-2 text-pretty"
        >
          {isOwner ? GROUP_LIMIT_OWNER : groupLimitMemberCopy(ownerName())}
        </p>
        {isOwner ? (
          <div className="-mx-3 flex flex-col">
            <SupportRows
              onContact={() => openSupport('contact')}
              onBook={() => openSupport('book')}
            />
          </div>
        ) : null}
      </>
    );
  }

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
      <p data-new-chat-missing="" role="alert" className="ml-auto text-right text-base text-bad">
        {missing}
      </p>
    );
  }

  function body(): ReactElement {
    if (mode === 'choose') {
      return (
        <div className="flex flex-col gap-2">
          <PressableRow
            className="flex items-center gap-2 border border-border bg-panel px-4 text-base font-medium text-fg"
            onClick={() => setMode('dm')}
          >
            <IconUser size={ICON_SIZE.inline} />
            New direct message
          </PressableRow>
          <PressableRow
            className="flex items-center gap-2 border border-border bg-panel px-4 text-base font-medium text-fg disabled:cursor-not-allowed disabled:text-fg-2 disabled:hover:bg-panel"
            disabled={blocked}
            aria-describedby={blocked ? 'group-limit-note' : undefined}
            data-new-group-row=""
            onClick={() => setMode('group')}
          >
            <IconChat size={ICON_SIZE.inline} />
            New group
          </PressableRow>
          {blocked ? groupLimitNote() : null}
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
          emptyLabel="People in this workspace show up here."
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
          <p className="mb-1.5 text-base font-medium">Members</p>
          <MemberPicker
            options={options}
            selectedIds={selectedIds}
            onToggle={toggleSelected}
            loading={members.loading}
            error={members.error}
            emptyLabel="People in this workspace show up here."
          />
        </div>
      </div>
    );
  }
}
