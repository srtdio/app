// Settings > Workspace: the client name, logo and timezone (owner/admin edit via
// workspace_update; everyone else reads), the platform (read-only, fixed at
// creation), and for the owner only the approved approver addresses. Every
// colour is a theme token for light/dark parity; every control is >=44px.

import { useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { platformLabel } from '@srtdio/posts';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/toast';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { supabase } from '@/lib/supabase';
import { uploadAvatarFile } from '@/lib/avatar-upload';
import { groupAvatarPng } from '@/lib/chat/group-avatar';
import { useSession } from '@/lib/session-context';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useWorkspaceCapability } from '@/lib/workspace-context-capability';
import type { WorkspacePatch } from '@/lib/workspace-context';
import { ApprovedAddressesSection } from './ApprovedAddressesSection';
import {
  NAME_MAX,
  isValidClientName,
  timezoneOptions,
  updateWorkspace,
  workspaceUpdateErrorMessage,
  type WorkspaceUpdatePayload,
} from './workspace-settings-data';

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

  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<'name' | 'logo' | 'timezone' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (row === null || workspaceId === null) {
    return <p className="text-sm text-fg-3">Loading workspace</p>;
  }
  const activeId = workspaceId;
  const name = nameDraft ?? row.name;
  const nameChanged = name.trim() !== row.name;

  async function save(
    field: 'name' | 'logo' | 'timezone',
    payload: WorkspaceUpdatePayload,
    patch: WorkspacePatch,
    done: string,
    traceId: string = newTrace(),
  ): Promise<boolean> {
    setBusy(field);
    setError(null);
    const res = await updateWorkspace(supabase, { workspaceId: activeId, payload, traceId });
    setBusy(null);
    if (!res.ok) {
      setError(workspaceUpdateErrorMessage(res.error.message));
      return false;
    }
    applyWorkspacePatch(activeId, patch);
    toast.show({ title: done, tone: 'success' });
    return true;
  }

  async function saveName(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isValidClientName(name)) {
      setError(`Client name must be 1 to ${NAME_MAX} characters.`);
      return;
    }
    const trimmed = name.trim();
    if (await save('name', { name: trimmed }, { name: trimmed }, 'Client name saved')) {
      setNameDraft(null);
    }
  }

  // Crop to a square PNG, upload through the avatar-upload worker, then
  // workspace_update logo_url; one trace id for the whole action.
  async function uploadLogo(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    const traceId = newTrace();
    const endpoint = env.VITE_AVATAR_UPLOAD_URL;
    if (endpoint === undefined) {
      setError('Logo upload is not configured.');
      return;
    }
    setBusy('logo');
    setError(null);
    const png = await groupAvatarPng(file);
    if (png === null) {
      setBusy(null);
      setError('Could not read the image. Choose it again.');
      return;
    }
    const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
    const up = await uploadAvatarFile(png, {
      endpoint,
      token,
      fetcher: (input, init) => fetchWithTrace(input, init, traceId),
    });
    if (!up.ok) {
      setBusy(null);
      setError(up.error.message);
      return;
    }
    const url = up.data.avatarUrl;
    await save('logo', { logo_url: url }, { logo_url: url }, 'Logo updated', traceId);
  }

  const logo = row.logo_url !== null && row.logo_url !== '' ? row.logo_url : null;
  const timezones = timezoneOptions(row.timezone).map((zone) => ({ value: zone, label: zone }));

  return (
    <div className="flex max-w-[520px] flex-col gap-6">
      {canEdit ? (
        <form onSubmit={(e) => void saveName(e)} className="flex flex-col gap-2">
          <Field label="Client name" htmlFor="workspace-client-name">
            <Input
              id="workspace-client-name"
              value={name}
              maxLength={NAME_MAX}
              onChange={(e) => {
                setNameDraft(e.target.value);
                setError(null);
              }}
              disabled={busy === 'name'}
            />
          </Field>
          <div>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={!nameChanged || busy === 'name'}
            >
              {busy === 'name' ? 'Saving' : 'Save name'}
            </Button>
          </div>
        </form>
      ) : (
        <Field label="Client name">
          <ReadOnlyValue>{row.name}</ReadOnlyValue>
        </Field>
      )}

      <Field label="Logo">
        <div className="flex flex-wrap items-center gap-3">
          <Avatar name={row.name} size="xl" shape="rounded" {...(logo ? { src: logo } : {})} />
          {canEdit ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                className="hidden"
                aria-label="Logo file"
                onChange={(e) => void uploadLogo(e)}
              />
              <Button
                type="button"
                size="lg"
                disabled={busy === 'logo'}
                onClick={() => fileRef.current?.click()}
              >
                {busy === 'logo' ? 'Uploading' : logo !== null ? 'Change logo' : 'Upload logo'}
              </Button>
              {logo !== null ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="lg"
                  disabled={busy === 'logo'}
                  onClick={() =>
                    void save('logo', { logo_url: '' }, { logo_url: null }, 'Logo removed')
                  }
                >
                  Remove
                </Button>
              ) : null}
            </>
          ) : logo === null ? (
            <span className="text-sm text-fg-3">No logo</span>
          ) : null}
        </div>
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
            disabled={busy === 'timezone'}
            onChange={(zone) => {
              if (zone !== row.timezone) {
                void save('timezone', { timezone: zone }, { timezone: zone }, 'Timezone saved');
              }
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
