// Settings > Workspace: the client name and platform (read-only for everyone,
// final after creation), the timezone (owner/admin edit via workspace_update;
// everyone else reads), and for the owner only the approved approver addresses.
// No workspace logo in v2.0. Every colour is a theme token for light/dark
// parity; every control is >=44px.

import { useState } from 'react';
import { platformLabel } from '@srtdio/posts';
import { Field } from '@/components/ui/Field';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/toast';
import { supabase } from '@/lib/supabase';
import { useSession } from '@/lib/session-context';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import { ApprovedAddressesSection } from './ApprovedAddressesSection';
import {
  timezoneOptions,
  updateWorkspace,
  workspaceUpdateErrorMessage,
} from './workspace-settings-data';

export const CLIENT_NAME_FIXED_LINE =
  'Fixed when the workspace was created. To change it, delete this workspace and create a new one.';

export const PLATFORM_FIXED_LINE =
  'Fixed when the workspace was created. Another platform means another workspace.';

function ReadOnlyValue({ children }: { children: string }) {
  return <p className="min-h-[44px] py-2.5 text-sm text-fg">{children}</p>;
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

  if (row === null || workspaceId === null) {
    return <p className="text-sm text-fg-3">Loading workspace</p>;
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
      <Field label="Client name" hint={CLIENT_NAME_FIXED_LINE}>
        <ReadOnlyValue>{row.name}</ReadOnlyValue>
      </Field>

      <Field label="Platform" hint={PLATFORM_FIXED_LINE}>
        <div className="flex min-h-[44px] items-center gap-2 text-sm text-fg">
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
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}

      {isOwner ? (
        <ApprovedAddressesSection workspaceId={activeId} clientDomain={row.client_domain} />
      ) : null}
    </div>
  );
}
