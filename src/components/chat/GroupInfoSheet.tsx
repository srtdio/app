import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Sheet } from '@/components/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { IconButton } from '@/components/ui/IconButton';
import { Avatar } from '@/components/ui/Avatar';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconSignOut, IconX } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { useNewTrace } from '@/lib/trace-context';
import { listGroupMemberIds, readProfiles } from '@/lib/chat-reads';
import {
  addGroupMember,
  leaveGroupChannel,
  removeGroupMember,
  renameGroupChannel,
} from '@/components/chat/chat-actions';
import { MemberPicker } from '@/components/chat/MemberPicker';
import {
  excludeMembers,
  toMemberOptions,
  type MemberOption,
} from '@/components/chat/member-picker';
import { useWorkspaceMembers } from '@/components/chat/use-workspace-members';

interface GroupInfoSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  groupId: string;
  groupName: string;
  currentUserId: string;
  /** Called after rename / add / remove so the parent refreshes the channel list. */
  onChanged: () => void;
  /** Called after the current user leaves the group. */
  onLeft: () => void;
}

interface MembersState {
  options: MemberOption[];
  loading: boolean;
  error: string | null;
}

/**
 * Group management panel reached from a group channel header: rename the group,
 * add and remove members (removal and leaving are confirmed), and leave the
 * group. Management controls are gated on the actor being a current group member
 * (the app has no finer-grained capability key); a non-member sees a read-only
 * member list. All mutations go through the procs and refresh the affected reads;
 * domain failures surface inline and never throw.
 */
export function GroupInfoSheet(props: GroupInfoSheetProps): ReactElement {
  const newTrace = useNewTrace();
  const workspaceMembers = useWorkspaceMembers(props.workspaceId);

  const [members, setMembers] = useState<MembersState>({
    options: [],
    loading: true,
    error: null,
  });
  const [name, setName] = useState(props.groupName);
  const [addId, setAddId] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<MemberOption | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadMembers = useCallback(async (): Promise<MembersState> => {
    const ids = await listGroupMemberIds(supabase, { groupId: props.groupId });
    if (!ids.ok) return { options: [], loading: false, error: ids.error.message };
    const profiles = await readProfiles(supabase, ids.data);
    if (!profiles.ok) return { options: [], loading: false, error: profiles.error.message };
    return { options: toMemberOptions(profiles.data), loading: false, error: null };
  }, [props.groupId]);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setName(props.groupName);
    setAddId(null);
    setError(null);
    setMembers({ options: [], loading: true, error: null });
    void loadMembers().then((next) => {
      if (!cancelled) setMembers(next);
    });
    return () => {
      cancelled = true;
    };
  }, [props.open, props.groupName, loadMembers]);

  const memberIds = members.options.map((m) => m.userId);
  const canManage = memberIds.includes(props.currentUserId);
  const addOptions = excludeMembers(workspaceMembers.options, memberIds);
  const nameChanged = name.trim().length > 0 && name.trim() !== props.groupName;

  async function refreshMembers(): Promise<void> {
    const next = await loadMembers();
    setMembers(next);
  }

  async function submitRename(): Promise<void> {
    if (!nameChanged || busy) return;
    setBusy(true);
    setError(null);
    const failure = await renameGroupChannel(
      supabase,
      { groupId: props.groupId, name: name.trim(), traceId: newTrace() },
      props.onChanged,
    );
    setBusy(false);
    if (failure !== null) setError(failure.message);
  }

  async function submitAdd(): Promise<void> {
    if (addId === null || busy) return;
    setBusy(true);
    setError(null);
    const failure = await addGroupMember(
      supabase,
      { groupId: props.groupId, userId: addId, traceId: newTrace() },
      props.onChanged,
    );
    setBusy(false);
    if (failure !== null) {
      setError(failure.message);
      return;
    }
    setAddId(null);
    await refreshMembers();
  }

  async function confirmRemove(): Promise<void> {
    if (removeTarget === null) return;
    setBusy(true);
    setError(null);
    const failure = await removeGroupMember(
      supabase,
      { groupId: props.groupId, userId: removeTarget.userId, traceId: newTrace() },
      props.onChanged,
    );
    setBusy(false);
    setRemoveTarget(null);
    if (failure !== null) {
      setError(failure.message);
      return;
    }
    await refreshMembers();
  }

  async function confirmLeave(): Promise<void> {
    setBusy(true);
    setError(null);
    const failure = await leaveGroupChannel(
      supabase,
      { groupId: props.groupId, traceId: newTrace() },
      props.onLeft,
    );
    setBusy(false);
    setLeaving(false);
    if (failure !== null) setError(failure.message);
  }

  return (
    <>
      <Sheet open={props.open} onClose={props.onClose} title="Group info">
        {error !== null ? (
          <div
            role="alert"
            className="mb-3 rounded-md border border-bad px-3 py-2 text-sm text-bad"
          >
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-5">
          {canManage ? (
            <Field label="Group name" htmlFor="group-rename" required>
              <div className="flex items-center gap-2">
                <Input
                  id="group-rename"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  aria-label="Group name"
                />
                <Button
                  size="lg"
                  variant="primary"
                  disabled={!nameChanged || busy}
                  onClick={() => void submitRename()}
                >
                  Save
                </Button>
              </div>
            </Field>
          ) : (
            <div>
              <p className="text-sm font-medium">{props.groupName}</p>
            </div>
          )}

          <section>
            <p className="mb-1.5 text-sm font-medium">Members</p>
            {members.loading ? (
              <p className="px-1 py-2 text-sm text-fg-3">Loading members</p>
            ) : members.error !== null ? (
              <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
                {members.error}
              </div>
            ) : (
              <ul className="flex flex-col">
                {members.options.map((member) => (
                  <li key={member.userId} className="flex items-center gap-3 px-1 min-h-[44px]">
                    <Avatar
                      name={member.displayName}
                      {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
                      size="md"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">
                      {member.displayName}
                      {member.userId === props.currentUserId ? (
                        <span className="ml-1 text-fg-3">(you)</span>
                      ) : null}
                    </span>
                    {canManage && member.userId !== props.currentUserId ? (
                      <IconButton
                        label={`Remove ${member.displayName}`}
                        disabled={busy}
                        onClick={() => setRemoveTarget(member)}
                      >
                        <IconX size={18} />
                      </IconButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {canManage ? (
            <section>
              <p className="mb-1.5 text-sm font-medium">Add members</p>
              <MemberPicker
                options={addOptions}
                selectedIds={addId !== null ? [addId] : []}
                onToggle={(id) => setAddId((prev) => (prev === id ? null : id))}
                loading={workspaceMembers.loading}
                error={workspaceMembers.error}
                emptyLabel="Everyone in this workspace is already a member."
              />
              <Button
                size="lg"
                variant="primary"
                className="mt-2"
                disabled={addId === null || busy}
                onClick={() => void submitAdd()}
              >
                {busy ? 'Adding' : 'Add to group'}
              </Button>
            </section>
          ) : null}

          {canManage ? (
            <section>
              <Button size="lg" variant="danger" disabled={busy} onClick={() => setLeaving(true)}>
                <IconSignOut size={18} />
                Leave group
              </Button>
            </section>
          ) : null}
        </div>
      </Sheet>

      {removeTarget !== null ? (
        <ConfirmDialog
          title="Remove member"
          message={`Remove ${removeTarget.displayName} from this group?`}
          confirmLabel="Remove"
          destructive
          busy={busy}
          busyLabel="Removing"
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}

      {leaving ? (
        <ConfirmDialog
          title="Leave group"
          message="You will stop receiving messages in this group. Leave it?"
          confirmLabel="Leave"
          destructive
          busy={busy}
          busyLabel="Leaving"
          onConfirm={() => void confirmLeave()}
          onCancel={() => setLeaving(false)}
        />
      ) : null}
    </>
  );
}
