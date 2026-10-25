// Settings > Workspace: the brand name and platform (read-only for everyone,
// final after creation), the timezone (owner/admin edit via workspace_update;
// everyone else reads), and for the owner only the approved approver addresses.
// No workspace logo at launch. Every colour is a theme token for light/dark
// parity; every control is >=44px.
//
// Danger: the owner deletes the workspace for good (workspace_delete) after
// typing its brand name exactly; everyone else reads that only the owner can.

import { useState } from 'react';
import { platformLabel } from '@srtdio/posts';
import { workspaceDelete } from '@srtdio/rpc';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { Select } from '@/components/ui/Select';
import { Sheet } from '@/components/ui/Sheet';
import { useToast } from '@/components/ui/toast';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { ApprovedAddressesSection } from './ApprovedAddressesSection';
import {
  canConfirmWorkspaceDelete,
  clearDeletedWorkspaceData,
  DELETE_OWNER_ONLY_LINE,
  deleteWorkspaceBody,
  deleteWorkspaceHint,
  deleteWorkspaceTitle,
  timezoneOptions,
  updateWorkspace,
  workspaceDeletedToast,
  workspaceDeleteErrorMessage,
  workspaceUpdateErrorMessage,
} from './workspace-settings-data';

export const CLIENT_NAME_FIXED_LINE =
  'Fixed when the workspace was created. To change it, delete this workspace and create a new one.';

export const PLATFORM_FIXED_LINE =
  'Fixed when the workspace was created. Another platform means another workspace.';

function ReadOnlyValue({ children }: { children: string }) {
  return <p className="min-h-[44px] py-2.5 text-base text-fg">{children}</p>;
}

/** The type-the-name sheet; Delete permanently runs workspace_delete. */
function DeleteWorkspaceSheet({
  open,
  workspaceId,
  name,
  userId,
  onClose,
}: {
  open: boolean;
  workspaceId: string;
  name: string;
  userId: string;
  onClose: () => void;
}) {
  const { workspaceDeleted } = useWorkspace();
  const newTrace = useNewTrace();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    if (deleting) return;
    setTyped('');
    setError(null);
    onClose();
  }

  async function confirm(): Promise<void> {
    if (deleting || !canConfirmWorkspaceDelete(typed, name)) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await workspaceDelete(supabase, {
        p_workspace_id: workspaceId,
        p_confirm_name: typed,
        p_trace_id: newTrace(),
      });
      if (!res.ok) {
        setError(workspaceDeleteErrorMessage(res.error.message));
        return;
      }
      // Closed first: the panel stays mounted for the next workspace, if any.
      setTyped('');
      onClose();
      clearDeletedWorkspaceData(workspaceId, userId);
      toast.show({ title: workspaceDeletedToast(name) });
      await workspaceDeleted(workspaceId, name);
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={close}
      title={deleteWorkspaceTitle(name)}
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            className="ml-auto"
            onClick={close}
            disabled={deleting}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={deleting || !canConfirmWorkspaceDelete(typed, name)}
            onClick={() => void confirm()}
          >
            Delete permanently
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-base leading-snug text-fg-2">{deleteWorkspaceBody(name)}</p>
        <Field label={deleteWorkspaceHint(name)} htmlFor="delete-workspace-name">
          <Input
            id="delete-workspace-name"
            value={typed}
            onChange={(e) => {
              setTyped(e.target.value);
              setError(null);
            }}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={deleting}
          />
        </Field>
        {error !== null ? (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

export function WorkspaceSettingsPanel() {
  const { workspaceId, workspaces, applyWorkspacePatch } = useWorkspace();
  const { session } = useSession();
  const newTrace = useNewTrace();
  const toast = useToast();
  // The same check workspace_update runs (owner and admin hold it by default).
  const canEdit = useWorkspaceCapability('workspace.manage_settings') === true;
  const row = workspaces.find((w) => w.id === workspaceId) ?? null;
  const isOwner = row !== null && session !== null && row.owner_user_id === session.user.id;

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (row === null || workspaceId === null) {
    return <p className="text-base text-fg-3">Loading workspace</p>;
  }
  const activeId = workspaceId;

  // Timezone is the one editable field: the payload only ever carries it.
  async function saveTimezone(timezone: string): Promise<void> {
    setSaving(true);
    setError(null);
    const res = await updateWorkspace(supabase, {
      workspaceId: activeId,
      payload: { timezone },
      traceId: newTrace(),
    });
    setSaving(false);
    if (!res.ok) {
      setError(workspaceUpdateErrorMessage(res.error.message));
      return;
    }
    applyWorkspacePatch(activeId, { timezone });
    toast.show({ title: 'Timezone saved', tone: 'success' });
  }

  const timezones = timezoneOptions(row.timezone).map((zone) => ({ value: zone, label: zone }));

  return (
    <div className="flex max-w-[520px] flex-col gap-6">
      <Field label="Brand name" hint={CLIENT_NAME_FIXED_LINE}>
        <ReadOnlyValue>{row.name}</ReadOnlyValue>
      </Field>

      <Field label="Platform" hint={PLATFORM_FIXED_LINE}>
        <div className="flex min-h-[44px] items-center gap-2 text-base text-fg">
          <PlatformMark platform={row.platform} />
          <span>{platformLabel(row.platform)}</span>
        </div>
      </Field>

      <Field label="Timezone">
        {canEdit ? (
          <Select
            label="Timezone"
            value={row.timezone}
            options={timezones}
            disabled={saving}
            onChange={(zone) => {
              if (zone !== row.timezone) void saveTimezone(zone);
            }}
          />
        ) : (
          <ReadOnlyValue>{row.timezone}</ReadOnlyValue>
        )}
      </Field>

      {error !== null ? (
        <p role="alert" className="text-base text-bad">
          {error}
        </p>
      ) : null}

      {isOwner ? (
        <ApprovedAddressesSection workspaceId={activeId} clientDomain={row.client_domain} />
      ) : null}

      <section
        aria-labelledby="workspace-danger-title"
        className="flex flex-col gap-3 rounded-xl border border-border bg-panel p-4"
      >
        <h3
          id="workspace-danger-title"
          className="text-sm font-semibold uppercase tracking-[0.06em] text-fg-2"
        >
          Danger
        </h3>
        {isOwner && session !== null ? (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-base text-fg">Delete workspace</p>
              <p className="mt-0.5 text-base text-fg-2">Permanent. Nothing is saved.</p>
            </div>
            <Button type="button" variant="danger" onClick={() => setDeleteOpen(true)}>
              Delete
            </Button>
            <DeleteWorkspaceSheet
              open={deleteOpen}
              workspaceId={activeId}
              name={row.name}
              userId={session.user.id}
              onClose={() => setDeleteOpen(false)}
            />
          </div>
        ) : (
          <p className="text-base text-fg-2">{DELETE_OWNER_ONLY_LINE}</p>
        )}
      </section>
    </div>
  );
}
