// The extracted comment composer: the chat composer's row (leading "+", field,
// emoji, round Send), used by both the root composer and the per-thread reply
// composer (the reply passes a parentCommentId-bearing onSubmit). The "+" is
// chat's ComposerTray limited to Photos, File and Assets. Photos and File
// reuse the existing chat upload path verbatim (uploadFile -> asset-upload
// worker, which returns asset VERSION ids); picked files show as removable chips
// with per-file progress and inline failure, and never throw. Assets is chat's
// AssetPicker: a library pick is already uploaded, so its chip carries the
// pick's current version id and sends with the uploads. The composer owns
// no trace and no write wrapper: it hands the body + completed version ids back
// through onSubmit, and the panel mints one trace per action and writes through
// the SECURITY DEFINER createComment wrapper.

import { mark } from '@/lib/perf-marks';
import { linkTypedUsernames } from '@/lib/chat/mentions';
import { lazy, Suspense, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { itemIn, useFreshKeys } from '@/lib/motion';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { ComposerFrame } from '@/components/ui/Composer';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { IconButton } from '@/components/ui/IconButton';
import { MentionInput } from '@/components/comments/MentionInput';
import type { MentionInputHandle } from '@/components/comments/MentionInput';
import { CommentEmojiButton } from '@/components/comments/CommentEmojiButton';
import type { MentionCandidate } from '@/lib/workspace-members';
import { IconFile, IconSend, IconTrash, ICON_SIZE } from '@/components/ui/icons';
import { ComposerTray, type TrayTileId } from '@/components/chat/ComposerTray';
import { useChatLayout } from '@/components/chat/chat-type';
import type { AssetPicker as AssetPickerPart } from '@/components/chat/AssetPicker';
import { Thumbnail } from '@/components/media/Thumbnail';
import { env } from '@/lib/env';
import { appPresignCache } from '@/lib/shared-presign';
import { fileExtension } from '@/lib/assets';
import { precheckFile, UPLOAD_ACCEPT } from '@/lib/asset-upload';
import { IMAGE_ACCEPT, precheckImage, type ChatAttachmentUpload } from '@/lib/chat/attachments';
import { isLibraryImage, type LibraryAsset } from '@/lib/chat/asset-picker';

// The proc enforces a body length of 1..10000; mirror it client-side so submit
// disables and a friendly message shows before the request runs.
const MAX_BODY = 10000;
/** "10,000": a number format, never a date one (dates live in src/lib/time.ts). */
const MAX_BODY_TEXT = new Intl.NumberFormat('en-US').format(MAX_BODY);

interface CommentSubmitOptions {
  /** Asset VERSION ids of the completed uploads, passed to createComment. */
  attachmentVersionIds: string[];
}

/**
 * ok clears the draft. A failure keeps it (text and chips): `error` is shown
 * inline under the composer; `notified` means the parent already told the
 * person (a toast), so nothing is shown inline.
 */
export type CommentSubmitResult =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: false; notified: true };

interface CommentComposerProps {
  /** Write the comment; resolves ok to clear the draft, or an error to keep it. */
  onSubmit: (body: string, options: CommentSubmitOptions) => Promise<CommentSubmitResult>;
  /** Workspace members offered by the @-mention picker (avatar + name + role). */
  members: MentionCandidate[];
  /** Whether the attach affordance is shown (endpoint configured + a workspace). */
  canAttach: boolean;
  /** Upload one picked file via the shared asset pipeline; never throws. */
  uploadFile?: (file: File) => Promise<ChatAttachmentUpload>;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  /** Seed the editor on mount (e.g. a reply pre-tagging the author); forwarded
   *  verbatim to MentionInput. Undefined leaves the composer blank as before. */
  initialBody?: string;
  /** The guide's data-induction key for the submit button, where its hand can sit. */
  submitAnchor?: string;
  /** Every draft change (token form, the same shape initialBody takes), so a
   *  parent can keep the draft across close/reopen. */
  onBodyChange?: (body: string) => void;
  /** How many attachment chips the composer holds (any state), on each change,
   *  so a parent can guard Back while a draft holds files. */
  onAttachmentCountChange?: (count: number) => void;
}

export type PendingStatus =
  | { state: 'uploading' }
  | { state: 'done'; versionId: string }
  | { state: 'error'; message: string };

/** One picked file and its upload lifecycle, shown as a removable chip. Shared
 *  with SlotComposer, which runs the same upload flow once per slot. */
export interface Pending {
  id: string;
  file: File;
  previewUrl: string | null;
  status: PendingStatus;
  /**
   * False when the failure was the pre-check (too big, a refused type), which a
   * retry cannot change; absent or true, a failed upload offers Retry (FT17).
   */
  retryable?: boolean;
}

/** Whether a chip offers Retry: a failed upload, not a failed pre-check. Pure. */
export function canRetryPending(item: Pick<Pending, 'status' | 'retryable'>): boolean {
  return item.status.state === 'error' && item.retryable !== false;
}

let pendingSeq = 0;

/** A side button in the composer row: a bare 44 circle (one treatment, B3). */
export const COMPOSER_SIDE = 'shrink-0 rounded-full';

/** The comment composers' "+" tray: these tiles only, in this order. */
export const COMMENT_TRAY_TILES: readonly TrayTileId[] = ['photos', 'file', 'assets'];

/** Whether a library chip's image thumb can presign (the asset-read worker is configured). */
const LIBRARY_PRESIGN = env.VITE_ASSET_READ_URL !== undefined && env.VITE_ASSET_READ_URL !== '';

// Chat's library picker, loaded apart: it pulls chat's card modules, which the
// post screen never needs on paint (and which import this file back). The load
// starts when a "+" tray opens, so it is in hand by the Assets tap.
let assetPickerLoad: Promise<{ AssetPicker: typeof AssetPickerPart }> | null = null;
function loadAssetPicker(): Promise<{ AssetPicker: typeof AssetPickerPart }> {
  assetPickerLoad ??= import('@/components/chat/AssetPicker');
  return assetPickerLoad;
}

/** Chat's AssetPicker, as is (mounted only after the first Assets tap). */
export const LazyAssetPicker = lazy(() =>
  loadAssetPicker().then((mod) => ({ default: mod.AssetPicker })),
);

/** A "+" tray's onShownChange: warm the library picker when the tray shows. Stable. */
export function warmAssetPicker(shown: boolean): void {
  if (shown) void loadAssetPicker();
}

export function doneVersionIds(pending: readonly Pending[]): string[] {
  const ids: string[] = [];
  for (const item of pending) {
    if (item.status.state === 'done') ids.push(item.status.versionId);
  }
  return ids;
}

/**
 * Confirmed library picks added after the ones already held, in pick order; a
 * pick already held (same version) is not added twice. Pure.
 */
export function mergeLibraryPicks(
  held: readonly LibraryAsset[],
  picks: readonly LibraryAsset[],
): LibraryAsset[] {
  const have = new Set(held.map((asset) => asset.versionId));
  const out = [...held];
  for (const pick of picks) {
    if (have.has(pick.versionId)) continue;
    have.add(pick.versionId);
    out.push(pick);
  }
  return out;
}

/** What a send carries: the finished uploads, then the library picks. Pure. */
export function attachmentIdsOf(
  pending: readonly Pending[],
  library: readonly LibraryAsset[],
): string[] {
  return [...doneVersionIds(pending), ...library.map((asset) => asset.versionId)];
}

/** A library chip's list key (apart from an upload chip's). Pure. */
export function libraryChipKey(asset: Pick<LibraryAsset, 'versionId'>): string {
  return `lib-${asset.versionId}`;
}

export function CommentComposer({
  onSubmit,
  members,
  canAttach,
  uploadFile,
  placeholder = 'Add a comment',
  submitLabel = 'Post',
  autoFocus = false,
  initialBody,
  submitAnchor,
  onBodyChange,
  onAttachmentCountChange,
}: CommentComposerProps): ReactElement {
  const [body, setBody] = useState('');
  // The MentionInput is contentEditable and uncontrolled; clearing the draft
  // after a successful submit remounts it via this incrementing key.
  const [composerKey, setComposerKey] = useState(0);
  const [pending, setPending] = useState<Pending[]>([]);
  // Library picks (Assets): already uploaded, sent by their current version id.
  const [library, setLibrary] = useState<LibraryAsset[]>([]);
  // A new attach chip rises into place (itemIn) over its final state; chips
  // render uploads then library picks, so the list's children line up with it.
  const chipKeys = [...pending.map((item) => item.id), ...library.map(libraryChipKey)];
  const freshChips = useFreshKeys(chipKeys);
  const chipsRef = useRef<HTMLUListElement>(null);
  useLayoutEffect(() => {
    if (freshChips.size === 0) return;
    chipKeys.forEach((key, index) => {
      if (freshChips.has(key)) itemIn(chipsRef.current?.children[index] ?? null);
    });
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The library picker mounts on the first Assets tap only (nothing on paint),
  // then stays mounted so it can slide out.
  const [assetsMounted, setAssetsMounted] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const layout = useChatLayout();
  const trayId = useId();

  // The chip count up to the parent (its Back guard); after commit, never on paint.
  const chipCount = pending.length + library.length;
  const onAttachmentCountRef = useRef(onAttachmentCountChange);
  onAttachmentCountRef.current = onAttachmentCountChange;
  useEffect(() => {
    onAttachmentCountRef.current?.(chipCount);
  }, [chipCount]);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<MentionInputHandle>(null);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_BODY;
  const uploading = pending.some((item) => item.status.state === 'uploading');
  const hasReadyAttachment =
    pending.some((item) => item.status.state === 'done') || library.length > 0;
  const attachEnabled = canAttach && uploadFile !== undefined;
  const canSubmit =
    (trimmed.length > 0 || hasReadyAttachment) && !tooLong && !uploading && !submitting;

  // Upload one chip's file and settle its status; a failure keeps the chip
  // (with its file) so Retry can run it again.
  async function uploadPending(id: string, file: File): Promise<void> {
    if (uploadFile === undefined) return;
    const outcome = await uploadFile(file);
    setPending((prev) =>
      prev.map((item) =>
        item.id === id
          ? {
              ...item,
              status: outcome.ok
                ? { state: 'done', versionId: outcome.versionId }
                : { state: 'error', message: outcome.message },
            }
          : item,
      ),
    );
  }

  // Photos is image-only (precheckImage); File takes the full allowlist.
  async function addFiles(list: FileList | null, imageOnly = false): Promise<void> {
    if (list === null || uploadFile === undefined) return;
    for (const file of Array.from(list)) {
      const id = `c-att-${(pendingSeq += 1)}`;
      const check = imageOnly ? precheckImage(file) : precheckFile(file);
      if (!check.ok) {
        setPending((prev) => [
          ...prev,
          {
            id,
            file,
            previewUrl: null,
            status: { state: 'error', message: check.message },
            retryable: false,
          },
        ]);
        continue;
      }
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      setPending((prev) => [...prev, { id, file, previewUrl, status: { state: 'uploading' } }]);
      await uploadPending(id, file);
    }
  }

  // FT17: a failed upload's chip offers Retry, which re-runs the same upload.
  function retryPending(id: string): void {
    const target = pending.find((item) => item.id === id);
    if (target === undefined || !canRetryPending(target)) return;
    setPending((prev) =>
      prev.map((item) => (item.id === id ? { ...item, status: { state: 'uploading' } } : item)),
    );
    void uploadPending(id, target.file);
  }

  function removePending(id: string): void {
    setPending((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target?.previewUrl != null) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((item) => item.id !== id);
    });
  }

  function removeLibrary(versionId: string): void {
    setLibrary((prev) => prev.filter((asset) => asset.versionId !== versionId));
  }

  // A tray tile: Photos / File open their pickers, Assets the library picker.
  // Nothing opens while a send is on its way.
  function pickTile(id: TrayTileId): void {
    if (submitting) return;
    if (id === 'photos') photoInputRef.current?.click();
    else if (id === 'file') fileInputRef.current?.click();
    else if (id === 'assets') {
      setAssetsMounted(true);
      setAssetsOpen(true);
    }
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    mark('comment:send:tap');
    setSubmitting(true);
    setError(null);
    // A typed "@username" of a current member becomes a real mention too.
    const linked = linkTypedUsernames(
      body,
      members.map((m) => ({ userId: m.id, username: m.username })),
    );
    const result = await onSubmit(linked, {
      attachmentVersionIds: attachmentIdsOf(pending, library),
    });
    if (result.ok) {
      for (const item of pending) {
        if (item.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
      }
      setBody('');
      setComposerKey((key) => key + 1);
      setPending([]);
      setLibrary([]);
      setSubmitting(false);
      return;
    }
    // Keep the draft (text + chips) so a failed write is not lost.
    setError('error' in result ? result.error : null);
    setSubmitting(false);
  }

  return (
    // relative: the "+" tray sits above the composer, across its width.
    <div className="relative flex flex-col gap-2">
      {/* ui/Composer: "+", field, emoji, then the round Send on one row (chat's row). */}
      <ComposerFrame
        state={submitting ? { kind: 'sending' } : { kind: 'idle' }}
        leading={
          attachEnabled ? (
            <ComposerTray
              layout={layout}
              only={{ tiles: COMMENT_TRAY_TILES, trayId }}
              onShownChange={warmAssetPicker}
              onPick={pickTile}
            />
          ) : undefined
        }
        input={
          <MentionInput
            bare
            formatting
            key={composerKey}
            ref={editorRef}
            members={members}
            placeholder={placeholder}
            autoFocus={autoFocus}
            onChange={(next) => {
              setBody(next);
              onBodyChange?.(next);
            }}
            initialBody={initialBody}
          />
        }
        side={
          <CommentEmojiButton
            disabled={submitting}
            className={COMPOSER_SIDE}
            onPick={(char) => editorRef.current?.insertText(char)}
          />
        }
        send={
          <Button
            variant="primary"
            shape="round"
            aria-label={submitLabel}
            className="shrink-0"
            data-induction={submitAnchor}
            disabled={!canSubmit}
            busy={submitting}
            onClick={() => void submit()}
          >
            <IconSend size={ICON_SIZE.control} />
          </Button>
        }
      />

      {tooLong ? (
        <p role="alert" className="text-sm text-bad">
          Comments must be at most {MAX_BODY_TEXT} characters.
        </p>
      ) : null}

      {chipCount > 0 ? (
        <ul ref={chipsRef} className="flex flex-wrap gap-2">
          {pending.map((item) => (
            <PendingChip
              key={item.id}
              item={item}
              onRemove={() => removePending(item.id)}
              onRetry={() => retryPending(item.id)}
            />
          ))}
          {library.map((asset) => (
            <LibraryChip
              key={libraryChipKey(asset)}
              asset={asset}
              onRemove={() => removeLibrary(asset.versionId)}
            />
          ))}
        </ul>
      ) : null}

      {error !== null ? <ErrorNote>{error}</ErrorNote> : null}

      {/* File first: the full allowlist (its own picker); then Photos, images only. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="sr-only"
        onChange={(event) => {
          void addFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <input
        ref={photoInputRef}
        type="file"
        multiple
        accept={IMAGE_ACCEPT}
        data-photo-input=""
        className="sr-only"
        onChange={(event) => {
          void addFiles(event.target.files, true);
          event.target.value = '';
        }}
      />

      {assetsMounted ? (
        <Suspense fallback={null}>
          <LazyAssetPicker
            open={assetsOpen}
            onClose={() => setAssetsOpen(false)}
            onConfirm={(picks) => setLibrary((prev) => mergeLibraryPicks(prev, picks))}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * One library pick (Assets) as a removable chip: the same chip as an upload's,
 * done from the start (it is already uploaded). The thumb is the image through
 * the shared presign cache (chat's library chip), else the file glyph.
 */
export function LibraryChip({
  asset,
  onRemove,
}: {
  asset: LibraryAsset;
  onRemove: () => void;
}): ReactElement {
  const image = isLibraryImage(asset);
  return (
    <li
      data-library-chip={asset.versionId}
      className="flex items-center gap-2 rounded-xl border bg-panel-2 py-1 pl-1 pr-1 lit-card-muted"
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3">
        {image ? (
          <Thumbnail
            assetVersionId={asset.versionId}
            cache={appPresignCache()}
            presignEnabled={LIBRARY_PRESIGN}
            fallback={{ kind: 'glyph' }}
            alt={asset.name}
          />
        ) : (
          <IconFile size={ICON_SIZE.inline} />
        )}
      </span>
      <span className="flex min-w-0 max-w-44 flex-col">
        <span className="truncate text-sm font-medium text-fg" title={asset.name}>
          {asset.name}
        </span>
        <span className="text-xs text-fg-3">{fileExtension(asset.filename)}</span>
      </span>
      <IconButton label={`Remove ${asset.name}`} onClick={onRemove}>
        <IconTrash size={ICON_SIZE.control} />
      </IconButton>
    </li>
  );
}

export function PendingChip({
  item,
  onRemove,
  onRetry,
}: {
  item: Pending;
  onRemove: () => void;
  /** FT17: re-run a failed upload; the chip shows Retry only when given and retryable. */
  onRetry?: (() => void) | undefined;
}): ReactElement {
  const error = item.status.state === 'error';
  return (
    <li
      className={
        error
          ? 'flex items-center gap-2 rounded-xl border border-bad lit-bad bg-panel-2 py-1 pl-1 pr-1 lit-card-muted'
          : 'flex items-center gap-2 rounded-xl border bg-panel-2 py-1 pl-1 pr-1 lit-card-muted'
      }
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3">
        {item.previewUrl !== null ? (
          <img src={item.previewUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <IconFile size={ICON_SIZE.inline} />
        )}
      </span>
      <span className="flex min-w-0 max-w-44 flex-col">
        <span className="truncate text-sm font-medium text-fg" title={item.file.name}>
          {item.file.name}
        </span>
        <span className={error ? 'truncate text-xs text-bad' : 'text-xs text-fg-3'}>
          {item.status.state === 'uploading'
            ? 'Uploading'
            : item.status.state === 'error'
              ? item.status.message
              : fileExtension(item.file.name)}
        </span>
      </span>
      {onRetry !== undefined && canRetryPending(item) ? (
        <Button
          type="button"
          variant="link"
          className="min-w-11 shrink-0"
          aria-label={`Retry ${item.file.name}`}
          onClick={onRetry}
        >
          Retry
        </Button>
      ) : null}
      <IconButton label={`Remove ${item.file.name}`} onClick={onRemove}>
        <IconTrash size={ICON_SIZE.control} />
      </IconButton>
    </li>
  );
}
