// Settings > Workspace: the brand name and platform (read-only for everyone,
// final after creation), the timezone (owner/admin edit via workspace_update;
// everyone else reads), and for the owner only the approved approver addresses.
// No workspace logo in v2.0. Every colour is a theme token for light/dark
// parity; every control is >=44px.
//
// Also home of the storage warning (owner and admin only): one dismissible
// banner at 800 MB, read from the asset-upload Worker's GET /usage. Shared with
// the Assets page, which adds a toast after an upload.

import { useCallback, useEffect, useRef, useState } from 'react';
import { platformLabel } from '@srtdio/posts';
import { Field } from '@/components/ui/Field';
import { IconButton } from '@/components/ui/IconButton';
import { IconX } from '@/components/ui/icons';
import { PlatformMark } from '@/components/ui/PlatformMark';
import { Select } from '@/components/ui/Select';
import { useToast } from '@/components/ui/toast';
import { supabase } from '@/lib/supabase';
import { cn } from '@/lib/cn';
import { env } from '@/lib/env';
import { fetchWithTrace } from '@/lib/fetch';
import { logger } from '@/lib/logger';
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

const BYTES_PER_MB = 1024 * 1024;

/** The one storage warning line. */
export function storageWarningCopy(usedBytes: number): string {
  return `This workspace has used ${Math.floor(usedBytes / BYTES_PER_MB)} MB of its 1 GB.`;
}

/** The asset-upload Worker's GET /usage body. */
export interface StorageUsage {
  usedBytes: number;
  warnAtBytes: number;
  warn: boolean;
  exempt: boolean;
}

/** A well-formed /usage body, or null (the UI then shows nothing). */
export function parseStorageUsage(body: unknown): StorageUsage | null {
  if (typeof body !== 'object' || body === null) return null;
  const r = body as Record<string, unknown>;
  if (
    typeof r.usedBytes !== 'number' ||
    typeof r.warnAtBytes !== 'number' ||
    typeof r.warn !== 'boolean' ||
    typeof r.exempt !== 'boolean'
  ) {
    return null;
  }
  return { usedBytes: r.usedBytes, warnAtBytes: r.warnAtBytes, warn: r.warn, exempt: r.exempt };
}

/** GET {endpoint}/usage for a workspace. Never throws; any failure is null. */
export async function fetchStorageUsage(input: {
  endpoint: string;
  token: string;
  workspaceId: string;
  fetcher: (input: string, init: RequestInit) => Promise<Response>;
}): Promise<StorageUsage | null> {
  try {
    const base = input.endpoint.replace(/\/+$/, '');
    const url = `${base}/usage?workspace_id=${encodeURIComponent(input.workspaceId)}`;
    const res = await input.fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.token}` },
    });
    if (!res.ok) return null;
    return parseStorageUsage(await res.json());
  } catch (err: unknown) {
    logger.warn('storage usage read failed', { error: String(err) });
    return null;
  }
}

function dismissKey(workspaceId: string, userId: string): string {
  return `sorted:storage-warning-dismissed:${workspaceId}:${userId}`;
}

/** Whether this viewer dismissed the warning for this workspace. */
export function readWarningDismissed(workspaceId: string, userId: string): boolean {
  try {
    return localStorage.getItem(dismissKey(workspaceId, userId)) === '1';
  } catch {
    return false;
  }
}

export function writeWarningDismissed(workspaceId: string, userId: string): void {
  try {
    localStorage.setItem(dismissKey(workspaceId, userId), '1');
  } catch {
    // Storage blocked: the banner just closes for this visit.
  }
}

export interface StorageWarningState {
  /** The reading, or null when unknown, not allowed, or failed. */
  usage: StorageUsage | null;
  dismissed: boolean;
  dismiss: () => void;
  /** Re-read usage (after an upload); null on any failure or for non-managers. */
  refresh: () => Promise<StorageUsage | null>;
}

/**
 * The storage warning for the active workspace, for owner and admin only (the
 * workspace.manage_settings capability they hold by default). Everyone else
 * never calls the Worker.
 */
export function useStorageWarning(): StorageWarningState {
  const { workspaceId } = useWorkspace();
  const { session } = useSession();
  const newTrace = useNewTrace();
  // Held in a ref so a new trace factory never re-runs the read effect.
  const newTraceRef = useRef(newTrace);
  newTraceRef.current = newTrace;
  const canManage = useWorkspaceCapability('workspace.manage_settings') === true;
  const userId = session?.user.id ?? null;
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const read = useCallback(async (): Promise<StorageUsage | null> => {
    const endpoint = env.VITE_ASSET_UPLOAD_URL;
    if (!canManage || workspaceId === null || endpoint === undefined || endpoint === '') {
      return null;
    }
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') return null;
      return await fetchStorageUsage({
        endpoint,
        token,
        workspaceId,
        fetcher: (url, init) => fetchWithTrace(url, init, newTraceRef.current()),
      });
    } catch (err: unknown) {
      logger.warn('storage usage read failed', { error: String(err) });
      return null;
    }
  }, [canManage, workspaceId]);

  useEffect(() => {
    setUsage(null);
    setDismissed(
      workspaceId !== null && userId !== null && readWarningDismissed(workspaceId, userId),
    );
    let active = true;
    void read().then((next) => {
      if (active) setUsage(next);
    });
    return () => {
      active = false;
    };
  }, [read, workspaceId, userId]);

  const refresh = useCallback(async () => {
    const next = await read();
    setUsage(next);
    return next;
  }, [read]);

  const dismiss = useCallback(() => {
    if (workspaceId !== null && userId !== null) writeWarningDismissed(workspaceId, userId);
    setDismissed(true);
  }, [workspaceId, userId]);

  return { usage, dismissed, dismiss, refresh };
}

/** The dismissible 800 MB banner; renders nothing unless the reading says warn. */
export function StorageWarningBanner({
  usage,
  dismissed,
  dismiss,
  className,
}: Pick<StorageWarningState, 'usage' | 'dismissed' | 'dismiss'> & { className?: string }) {
  if (usage === null || !usage.warn || dismissed) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-xl border border-warn bg-warn-soft py-1 pl-4 pr-1 text-sm text-fg',
        className,
      )}
    >
      <p className="flex-1 py-2">{storageWarningCopy(usage.usedBytes)}</p>
      <IconButton label="Dismiss" onClick={dismiss} className="shrink-0">
        <IconX />
      </IconButton>
    </div>
  );
}

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
  const storage = useStorageWarning();

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
      <StorageWarningBanner {...storage} />

      <Field label="Brand name" hint={CLIENT_NAME_FIXED_LINE}>
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
