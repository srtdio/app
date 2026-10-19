import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { PageHead } from '@/components/shell/PageHead';
import { Toasts } from '@/components/pages/assets/Toasts';
import { useToasts } from '@/components/pages/assets/useToasts';
import { supabase } from '@/lib/supabase';
import { fetchWithTrace } from '@/lib/fetch';
import { env } from '@/lib/env';
import { useNewTrace } from '@/lib/trace-context';
import { useWorkspace } from '@/lib/workspace-context';
import { useSession } from '@/lib/session-context';
import { logger } from '@/lib/logger';
import {
  daysLeft,
  deletedBytes,
  emptyConfirmMessage,
  freesLine,
  goneInLine,
  listDeletedAssets,
  purgeAssets,
  restoreAsset,
  type DeletedAssetItem,
} from '@/lib/assets';

const RETRY = 'Something went wrong. Try again.';

/**
 * What a member who is not the owner reads under the list. The rule is
 * asset_purge_request's: only the workspace owner (workspaces.owner_user_id)
 * deletes for good early; any member restores.
 */
export const MEMBER_PURGE_NOTE =
  'Anyone in this workspace can restore a file. Only the workspace owner can delete files for good before the 31 days are up.';

// Delete now: a ghost button in the `bad` token, 44px like the rest.
const DELETE_NOW_CLASS =
  'inline-flex h-11 items-center justify-center rounded-md px-4 text-sm font-medium text-bad ' +
  'transition-colors hover:bg-panel-2 disabled:opacity-50 disabled:pointer-events-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent';

/** Which confirm is open: one file's Delete now, or Empty now. */
type PendingConfirm = { kind: 'one'; item: DeletedAssetItem } | { kind: 'all' } | null;

interface RecentlyDeletedViewProps {
  items: DeletedAssetItem[];
  now: number;
  isOwner: boolean;
  loading: boolean;
  /** The list read failed; the cause is logged, never shown. */
  failed: boolean;
  /** The row whose request is in flight; its actions are disabled. */
  busyId: string | null;
  onRetry: () => void;
  onRestore: (item: DeletedAssetItem) => void;
  onDeleteNow: (item: DeletedAssetItem) => void;
  onEmpty: () => void;
}

/**
 * The page body, hook-free so it renders to static markup in tests: the hint,
 * one two-line row per file (full name, then size and days left) with its
 * actions underneath, then the owner's Empty now or the member's note.
 */
export function RecentlyDeletedView({
  items,
  now,
  isOwner,
  loading,
  failed,
  busyId,
  onRetry,
  onRestore,
  onDeleteNow,
  onEmpty,
}: RecentlyDeletedViewProps) {
  return (
    <div className="px-4 md:px-6 py-4">
      <p className="text-sm text-fg-3">
        Files stay here 31 days, then are deleted for good. They still count toward storage until
        then.
      </p>

      {failed ? (
        <div className="mt-4">
          <div role="alert" className="rounded-xl border border-bad px-4 py-3 text-sm text-bad">
            Could not load assets.
          </div>
          <div className="mt-3">
            <Button size="lg" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      ) : loading && items.length === 0 ? (
        <div className="mt-4 flex flex-col gap-2" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              className="h-[104px] rounded-xl border border-border bg-panel animate-pulse"
            />
          ))}
        </div>
      ) : items.length > 0 ? (
        <>
          <ul className="mt-4 divide-y divide-border rounded-xl border border-border bg-panel">
            {items.map((item) => (
              <li key={item.id} className="px-4 py-3">
                <p className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{item.name}</p>
                <p className="mt-0.5 text-xs text-fg-3">
                  {goneInLine(item.sizeBytes, daysLeft(item.deletedAt, now))}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="lg" disabled={busyId === item.id} onClick={() => onRestore(item)}>
                    Restore
                  </Button>
                  {isOwner ? (
                    <button
                      type="button"
                      className={DELETE_NOW_CLASS}
                      disabled={busyId === item.id}
                      onClick={() => onDeleteNow(item)}
                    >
                      Delete now
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>

          <div className="mt-4">
            {isOwner ? (
              <div className="flex flex-col items-start gap-1.5">
                <Button size="lg" variant="danger" disabled={busyId !== null} onClick={onEmpty}>
                  Empty now
                </Button>
                <p className="text-xs text-fg-3">{freesLine(deletedBytes(items))}</p>
              </div>
            ) : (
              <p className="text-xs text-fg-3">{MEMBER_PURGE_NOTE}</p>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export function RecentlyDeletedPage() {
  const { workspaceId, workspaces } = useWorkspace();
  const { session } = useSession();
  const newTrace = useNewTrace();
  const { toasts, push, dismiss } = useToasts();
  // Owner: the same check the workspace settings panel runs.
  const row = workspaces.find((w) => w.id === workspaceId) ?? null;
  const isOwner = row !== null && session !== null && row.owner_user_id === session.user.id;

  const [items, setItems] = useState<DeletedAssetItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setLoading(true);
    setFailed(false);
    const result = await listDeletedAssets(supabase, workspaceId);
    setLoading(false);
    setNow(Date.now());
    if (!result.ok) {
      logger.warn('recently deleted: list read failed', { error: result.error.message });
      setFailed(true);
      return;
    }
    setItems(result.data);
  }, [workspaceId]);

  useEffect(() => {
    setItems([]);
    setConfirm(null);
    void load();
  }, [load]);

  const restore = useCallback(
    async (item: DeletedAssetItem): Promise<void> => {
      setBusyId(item.id);
      try {
        const result = await restoreAsset(supabase, item.id, newTrace());
        if (!result.ok) {
          push(RETRY);
          return;
        }
        setItems((prev) => prev.filter((candidate) => candidate.id !== item.id));
        push('Restored');
      } finally {
        setBusyId(null);
      }
    },
    [newTrace, push],
  );

  // Delete for good via the worker's /purge: one file (asset_ids [id]) or, with
  // no ids, everything here. The list is re-read after, so it matches the server.
  const purge = useCallback(
    async (assetIds: string[] | undefined): Promise<boolean> => {
      const endpoint = env.VITE_ASSET_UPLOAD_URL;
      if (endpoint === undefined || endpoint === '' || workspaceId === null) return false;
      const token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
      if (token === null || token === '') return false;
      const result = await purgeAssets({
        endpoint,
        token,
        workspaceId,
        assetIds,
        fetcher: (input, init) => fetchWithTrace(input, init, newTrace()),
      });
      if (result.ok) void load();
      return result.ok;
    },
    [workspaceId, newTrace, load],
  );

  const confirmPurge = useCallback(async (): Promise<void> => {
    if (confirm === null) return;
    setConfirmBusy(true);
    try {
      const ok = await purge(confirm.kind === 'one' ? [confirm.item.id] : undefined);
      if (!ok) {
        push(RETRY);
        return;
      }
      push(confirm.kind === 'one' ? 'Deleted for good' : 'Emptied. Space freed.');
    } catch (cause) {
      // getSession() can reject; the user sees the same failure toast.
      logger.warn('recently deleted: purge failed', {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      push(RETRY);
    } finally {
      setConfirmBusy(false);
      setConfirm(null);
    }
  }, [confirm, purge, push]);

  return (
    <>
      <PageHead title="Recently deleted" />
      <RecentlyDeletedView
        items={items}
        now={now}
        isOwner={isOwner}
        loading={workspaceId === null || loading}
        failed={failed}
        busyId={busyId}
        onRetry={() => void load()}
        onRestore={(item) => void restore(item)}
        onDeleteNow={(item) => setConfirm({ kind: 'one', item })}
        onEmpty={() => setConfirm({ kind: 'all' })}
      />

      {confirm !== null ? (
        <ConfirmDialog
          title={
            confirm.kind === 'one' ? `Delete ${confirm.item.name} now?` : 'Empty Recently deleted?'
          }
          message={
            confirm.kind === 'one'
              ? "Gone for good. Nothing is saved, and this can't be undone."
              : emptyConfirmMessage(items.length)
          }
          confirmLabel={confirm.kind === 'one' ? 'Delete now' : 'Empty now'}
          destructive
          busy={confirmBusy}
          onConfirm={() => void confirmPurge()}
          onCancel={() => setConfirm(null)}
        />
      ) : null}

      <Toasts toasts={toasts} onDismiss={dismiss} />
    </>
  );
}
