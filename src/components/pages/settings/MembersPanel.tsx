// Members panel container: wires the live reads to the presentational list,
// gates every action affordance to owner/admin, and drives the remove-member,
// cancel-invite, edit-invite and role-change flows through the existing Sheet +
// ConfirmDialog. The invite form stays at the top and refetches the list on a
// successful send. A return to the panel paints the list this session last
// read while the shared cache loads again (no "Loading members"); the new list
// lands while the person has not touched the screen, else the kept one stays
// (src/lib/kept-view.ts). The panel's own changes always land. A manager's
// Catch-up emails tick patches the held member entry at once (the list's mail
// tags and the sheet repaint in the same frame), then reverts on failure.

import { mark } from '@/lib/perf-marks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { memberRemove } from '@srtdio/rpc';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { LoadError } from '@/components/ui/LoadError';
import { useToast } from '@/components/ui/toast';
import { FORMER_MEMBER } from '@/lib/people-names';
import { logger } from '@/lib/logger';
import { supabase } from '@/lib/supabase';
import { readProfiles } from '@/lib/chat-reads';
import type { ChatProfile } from '@/lib/chat-reads';
import { useSession } from '@/lib/session-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useNewTrace } from '@/lib/trace-context';
import { useUntouched } from '@/lib/kept-view';
import {
  MembersInviteForm,
  getInviteRoleOptions,
  inviteErrorMessage,
  inviteRoleLabel,
  replacePendingInvite,
  sendInvite,
} from './MembersInviteForm';
import type { SentInvite } from './MembersInviteForm';
import { MembersList } from './MembersList';
import { LOADING_MEMBERS, SettingsRowBoxes } from './SettingsRowBoxes';
import type { PendingEditHandler } from './MembersList';
import { MemberActionSheet } from './MemberActionSheet';
import type {
  MemberEmailOptInHandler,
  MemberRoleChangeHandler,
  SheetPerson,
} from './MemberActionSheet';
import {
  activeMemberRole,
  canInviteMembers,
  canManageMembers,
  clientDomainLabel,
  clientDomainMismatchMessage,
  deriveMembers,
  emailPatchAfterManagerSet,
  memberEmailOptInOutcome,
  memberRemoveErrorMessage,
} from './members-data';
import type { DerivedMembers, MemberEntry } from './members-data';
import { keptWorkspaceMembers, useWorkspaceMembers } from '@/lib/workspace-members';
import type { WorkspaceMembersData } from '@/lib/workspace-members';
import { useInviteDelivery } from './useInviteDelivery';

/** A held member's catch-up email fields, as this panel last wrote or learned them. */
export type EmailPatch = { emailOptIn: boolean; emailOptOutBy: string | null };

/** The derived lists with the panel's own email patches laid over (by user id). Pure. */
export function withEmailPatches(
  derived: DerivedMembers,
  patches: ReadonlyMap<string, EmailPatch>,
): DerivedMembers {
  if (patches.size === 0) return derived;
  const patch = (member: MemberEntry): MemberEntry => {
    const next = patches.get(member.userId);
    return next === undefined ? member : { ...member, ...next };
  };
  return {
    agency: derived.agency.map(patch),
    client: derived.client.map(patch),
    pending: derived.pending,
  };
}

/** Managers named on a held entry (email_opt_out_by) who are not in the held list. Pure. */
export function missingOffByIds(derived: DerivedMembers): string[] {
  const active = [...derived.agency, ...derived.client];
  const held = new Set(active.map((m) => m.userId));
  const ids = active
    .map((m) => m.emailOptOutBy)
    .filter((id): id is string => typeof id === 'string' && !held.has(id));
  return [...new Set(ids)];
}

export function MembersPanel() {
  const { workspaceId, workspaceName, workspaceDisplayName } = useWorkspace();
  const { session } = useSession();
  const newTrace = useNewTrace();
  const toast = useToast();
  const currentUserId = session?.user.id ?? null;
  const live = useWorkspaceMembers(workspaceId);
  const untouched = useUntouched();
  // The list kept from an earlier visit this session, shown until a good new
  // list (not the one the cache held on arrival) lands untouched, the
  // workspace changes or the panel writes.
  const [arrival] = useState(() => ({
    live,
    list:
      currentUserId !== null && workspaceId !== null
        ? (keptWorkspaceMembers(currentUserId, workspaceId) ?? null)
        : null,
  }));
  const held = useRef<{ workspaceId: string | null; list: WorkspaceMembersData } | null>(
    arrival.list !== null ? { workspaceId, list: arrival.list } : null,
  );
  const wrote = useRef(false);
  const landed = !live.loading && live.error === null && live !== arrival.live;
  if (
    held.current !== null &&
    (held.current.workspaceId !== workspaceId || wrote.current || (landed && untouched()))
  ) {
    held.current = null;
  }
  const { loading, error, rows, profiles } = held.current?.list ?? live;
  if (!loading && error === null) mark('members:paint');
  const refetchMembers = live.refetch;
  const { delivery, refetch: refetchDelivery } = useInviteDelivery(workspaceId);
  // After a remove, a cancelled or edited invite, a role change or a fresh
  // invite: the shared members list re-reads for every screen, plus the pills.
  const refetch = useCallback(() => {
    wrote.current = true;
    refetchMembers();
    refetchDelivery();
  }, [refetchMembers, refetchDelivery]);

  const selfEmail = session?.user.email ?? null;

  // The panel's own Catch-up email writes, by user id, laid over every read.
  const [emailPatches, setEmailPatches] = useState<ReadonlyMap<string, EmailPatch>>(new Map());
  const derived = useMemo(
    () =>
      withEmailPatches(deriveMembers({ rows, profiles, currentUserId, selfEmail }), emailPatches),
    [rows, profiles, currentUserId, selfEmail, emailPatches],
  );
  const canManage = useMemo(() => canManageMembers(rows, currentUserId), [rows, currentUserId]);
  const callerRole = useMemo(() => activeMemberRole(rows, currentUserId), [rows, currentUserId]);
  const canInvite = useMemo(() => canInviteMembers(rows, currentUserId), [rows, currentUserId]);

  const [actionsFor, setActionsFor] = useState<MemberEntry | null>(null);
  // The open sheet follows the held entry, so a patch repaints it with the list.
  const sheetMember = useMemo(
    () =>
      actionsFor === null
        ? null
        : ([...derived.agency, ...derived.client].find((m) => m.id === actionsFor.id) ??
          actionsFor),
    [actionsFor, derived],
  );

  // A manager named as "Turned off by" who is not on this list (rare): one
  // batched read after paint, once per id for the panel's life.
  const [offByProfiles, setOffByProfiles] = useState<ReadonlyMap<string, ChatProfile>>(new Map());
  const requestedOffBy = useRef(new Set<string>());
  useEffect(() => {
    if (!canManage) return;
    const ids = missingOffByIds(derived).filter((id) => !requestedOffBy.current.has(id));
    if (ids.length === 0) return;
    for (const id of ids) requestedOffBy.current.add(id);
    // Dropped after unmount or a list change; a read cut short that way frees
    // its ids so the next run (if they are still missing) asks again.
    let live = true;
    let landed = false;
    void readProfiles(supabase, ids).then((res) => {
      landed = true;
      if (!live) return;
      if (!res.ok) {
        logger.warn('member email off-by read failed', { error: res.error.message });
        return;
      }
      setOffByProfiles((current) => {
        const next = new Map(current);
        for (const profile of res.data) next.set(profile.userId, profile);
        return next;
      });
    });
    return () => {
      live = false;
      if (!landed) for (const id of ids) requestedOffBy.current.delete(id);
    };
  }, [canManage, derived]);

  const personFor = useCallback(
    (userId: string): SheetPerson | null => {
      const held = [...derived.agency, ...derived.client].find((m) => m.userId === userId);
      if (held !== undefined) {
        return { userId, name: held.displayName, avatarUrl: held.avatarUrl };
      }
      const read = offByProfiles.get(userId);
      return read !== undefined
        ? { userId, name: read.displayName, avatarUrl: read.avatarUrl }
        : null;
    },
    [derived, offByProfiles],
  );
  const [confirmFor, setConfirmFor] = useState<MemberEntry | null>(null);
  const [removing, setRemoving] = useState(false);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  // Pending invite id -> address, for invites sent from this panel: the
  // membership rows carry no email, so the list shows these when known.
  const [sentEmails, setSentEmails] = useState<ReadonlyMap<string, string>>(new Map());

  const pendingEmails = useMemo(
    () =>
      new Map(
        derived.pending.flatMap((member) => {
          const email = sentEmails.get(member.id);
          return email !== undefined ? [[member.id, email] as const] : [];
        }),
      ),
    [derived.pending, sentEmails],
  );

  const workspaceLabel = workspaceDisplayName ?? 'this workspace';

  function rememberEmail(inviteId: string | null, email: string): void {
    if (inviteId === null) return;
    setSentEmails((current) => new Map(current).set(inviteId, email));
  }

  // Read the client domain fresh: the first approver invite sets it
  // server-side, so the cached workspace row can be stale.
  async function readClientDomain(): Promise<string> {
    if (workspaceId === null) return '';
    const res = await supabase
      .from('workspaces')
      .select('client_domain')
      .eq('id', workspaceId)
      .maybeSingle();
    const domain: unknown = res.error ? null : res.data?.client_domain;
    return clientDomainLabel(typeof domain === 'string' ? domain : null);
  }

  async function removeMember(member: MemberEntry): Promise<boolean> {
    const result = await memberRemove(supabase, {
      p_member_id: member.id,
      p_trace_id: newTrace(),
    });
    if (!result.ok) logger.warn('member remove failed', { code: result.error.code });
    return result.ok;
  }

  function handleInvited(sent: readonly SentInvite[]): void {
    for (const invite of sent) rememberEmail(invite.inviteId, invite.email);
    refetch();
    const emailed = sent.filter((invite) => invite.status !== 'not-sent');
    const first = emailed[0];
    if (first === undefined) return;
    toast.show({
      title:
        emailed.length === 1 ? `Invite sent to ${first.email}` : `${emailed.length} invites sent`,
    });
  }

  async function performRemove(member: MemberEntry): Promise<void> {
    mark('member:remove:tap');
    setRemoving(true);
    const result = await memberRemove(supabase, {
      p_member_id: member.id,
      p_trace_id: newTrace(),
    });
    mark('member:remove:end');
    setRemoving(false);
    if (result.ok) {
      setConfirmFor(null);
      setActionsFor(null);
      refetch();
      toast.show({ title: `${member.displayName} removed` });
      return;
    }
    // Expected failures arrive on the Result branch; show friendly copy, keep
    // the dialog open so the user can dismiss. No automatic retry.
    toast.show({ title: memberRemoveErrorMessage(result.error.code) });
  }

  async function performCancel(member: MemberEntry): Promise<void> {
    setCancellingId(member.id);
    const result = await memberRemove(supabase, {
      p_member_id: member.id,
      p_trace_id: newTrace(),
    });
    setCancellingId(null);
    if (result.ok) {
      refetch();
      toast.show({
        title: `Invite to ${pendingEmails.get(member.id) ?? member.displayName} cancelled`,
      });
      return;
    }
    toast.show({ title: memberRemoveErrorMessage(result.error.code) });
  }

  const performEditInvite: PendingEditHandler = async (member, { email, role, sameEmail }) => {
    if (workspaceId === null) return inviteErrorMessage(null, '');
    const activeWorkspaceId = workspaceId;
    const result = await replacePendingInvite({
      memberId: member.id,
      sameEmail,
      send: () =>
        sendInvite({
          workspaceId: activeWorkspaceId,
          email,
          role,
          traceId: newTrace(),
          invoke: (name, options) => supabase.functions.invoke(name, options),
        }),
      remove: () => removeMember(member),
    });
    if (result.ok) {
      rememberEmail(result.inviteId, email);
      refetch();
      toast.show({ title: `New invite sent to ${email} as ${inviteRoleLabel(role)}` });
      return null;
    }
    const clientDomain = result.code === 'client_domain_mismatch' ? await readClientDomain() : '';
    const message = inviteErrorMessage(result.code, clientDomain);
    if (!result.oldCancelled) return message;
    // The old invite is gone although the new one failed: its row leaves the
    // list on refetch, so the toast carries both lines.
    refetch();
    toast.show({
      title: `Invite to ${pendingEmails.get(member.id) ?? member.displayName} cancelled`,
      description: message,
    });
    return message;
  };

  const performRoleChange: MemberRoleChangeHandler = async (member, role) => {
    // Args as a variable: p_trace_id is the proc's real trace parameter.
    const args = { p_member_id: member.id, p_role: role, p_trace_id: newTrace() };
    const { error: roleError } = await supabase.rpc('member_role_set', args);
    if (roleError === null) {
      setActionsFor(null);
      refetch();
      toast.show({ title: `Role changed to ${inviteRoleLabel(role)}` });
      return null;
    }
    if (roleError.message === 'client_domain_mismatch') {
      return clientDomainMismatchMessage(await readClientDomain());
    }
    logger.warn('member role change failed', { error: roleError.message });
    return memberRemoveErrorMessage('unknown');
  };

  function patchEmail(userId: string, next: EmailPatch | undefined): void {
    setEmailPatches((current) => {
      const map = new Map(current);
      if (next === undefined) map.delete(userId);
      else map.set(userId, next);
      return map;
    });
  }

  const performEmailOptInSet: MemberEmailOptInHandler = async (member, emailOptIn) => {
    const traceId = newTrace();
    const before = emailPatches.get(member.userId);
    // Painted before the call: the list's tag and the sheet change in this frame.
    patchEmail(member.userId, emailPatchAfterManagerSet(emailOptIn, currentUserId));
    // Args as a variable: p_trace_id is the proc's real trace parameter. The
    // caller is never sent; the proc reads it from the session.
    const args = { p_user_id: member.userId, p_email_opt_in: emailOptIn, p_trace_id: traceId };
    const { error: optInError } = await supabase.rpc('member_email_opt_in_set', args);
    const outcome = memberEmailOptInOutcome(optInError);
    if (outcome === 'turned_off_by_member') {
      // They turned it off themselves since the read: only they can turn it on.
      patchEmail(member.userId, { emailOptIn: false, emailOptOutBy: null });
    } else if (outcome === 'failed') {
      patchEmail(member.userId, before);
      logger.warn('member email opt-in set failed', { error: optInError?.message ?? '' });
    }
    return outcome;
  };

  return (
    <div className="flex flex-col gap-6">
      {canInvite ? (
        <MembersInviteForm
          clientOnly={callerRole === 'client'}
          invitedEmails={Array.from(pendingEmails.values())}
          loadClientDomain={readClientDomain}
          onInvited={handleInvited}
        />
      ) : null}

      {loading ? (
        <SettingsRowBoxes label={LOADING_MEMBERS} />
      ) : error !== null ? (
        // A failed or timed-out read: Retry re-reads the shared list in place
        // (its generation guard drops a late answer from the failed read).
        <LoadError title="members" onRetry={refetchMembers} />
      ) : (
        <MembersList
          derived={derived}
          clientName={workspaceName}
          canManage={canManage}
          cancellingId={cancellingId}
          delivery={delivery}
          pendingEmails={pendingEmails}
          roleOptions={getInviteRoleOptions(false)}
          onChangeRole={(member) => setActionsFor(member)}
          onRemove={(member) => setConfirmFor(member)}
          onCancelInvite={performCancel}
          onEditInvite={performEditInvite}
        />
      )}

      <MemberActionSheet
        member={sheetMember}
        open={actionsFor !== null}
        canManage={canManage}
        viewerId={currentUserId}
        onClose={() => setActionsFor(null)}
        onChangeRole={performRoleChange}
        onSetEmailOptIn={performEmailOptInSet}
        personFor={personFor}
      />

      {confirmFor !== null ? (
        <ConfirmDialog
          title={`Remove ${confirmFor.displayName}?`}
          message={[
            `They lose access to ${workspaceLabel} the moment you confirm.`,
            'Signed out everywhere. Chat access ends immediately.',
            `Their posts, comments and uploads stay, shown as “${FORMER_MEMBER}”.`,
            'You can invite them back any time.',
          ].join('\n')}
          confirmLabel="Remove member"
          busyLabel="Removing"
          destructive
          busy={removing}
          onConfirm={() => void performRemove(confirmFor)}
          onCancel={() => setConfirmFor(null)}
        />
      ) : null}
    </div>
  );
}
