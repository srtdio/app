// The client checkpoint composer: single-line slots that grow as typed, each
// numbered with the checkpoint number it will take (continuing after the
// post's existing ledger_seq; the empty next slot is a dashed ring), one point
// per slot, added with the small
// "+ Another" ghost under the slots, all sent in ONE comment_batch_create
// call (the round Send, named "Send" for one, "Send N checkpoints" for more). It
// replaces only the CLIENT-role TOP-LEVEL composer on posts; replies (any
// role), the agency composer, and brief comments keep the free-text
// CommentComposer untouched. Checkpoints carry no mentions, so a slot is a
// plain textarea, never MentionInput. Each slot has the comment composer's "+"
// (chat's tray: Photos, File, Assets). Uploads reuse the existing comment
// attachment flow (uploadFile -> asset-upload worker, returning asset VERSION
// ids) and Assets picks are library versions; each slot's completed version
// ids (uploads, then picks) ride with that slot's point. The
// composer owns no trace and no write wrapper: it hands the points back
// through onSubmit and the panel mints one trace per batch.

import { Suspense, useId, useLayoutEffect, useRef, useState } from 'react';
import { itemIn, useFreshKeys } from '@/lib/motion';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { ComposerFrame } from '@/components/ui/Composer';
import { ErrorNote } from '@/components/ui/ErrorNote';
import { IconButton } from '@/components/ui/IconButton';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/cn';
import { IconSend, IconX, ICON_SIZE } from '@/components/ui/icons';
import { precheckFile, UPLOAD_ACCEPT } from '@/lib/asset-upload';
import { IMAGE_ACCEPT, precheckImage, type ChatAttachmentUpload } from '@/lib/chat/attachments';
import type { LibraryAsset } from '@/lib/chat/asset-picker';
import { ComposerTray, type TrayTileId } from '@/components/chat/ComposerTray';
import { useChatLayout } from '@/components/chat/chat-type';
import {
  COMMENT_TRAY_TILES,
  COMPOSER_SIDE,
  LazyAssetPicker,
  LibraryChip,
  PendingChip,
  attachmentIdsOf,
  canRetryPending,
  libraryChipKey,
  mergeLibraryPicks,
  warmAssetPicker,
} from '@/components/comments/CommentComposer';
import { CheckpointCircle } from '@/components/comments/CheckpointCircle';
import { CommentEmojiButton, insertIntoTextarea } from '@/components/comments/CommentEmojiButton';
import type { Pending } from '@/components/comments/CommentComposer';

/** One point exactly as comment_batch_create expects it inside p_points. */
export interface CheckpointPoint {
  body: string;
  attachment_version_ids?: string[];
}

/** The proc accepts 1..20 points per batch. */
export const MAX_POINTS = 20;
/** The word counter stays hidden below this count. */
export const COUNTER_FROM = 35;
/** A point is 1..50 words; over blocks send. */
export const MAX_WORDS = 50;
export const OVER_LIMIT_MESSAGE = 'Over 50 words. Split it into two checkpoints.';

/**
 * Word count exactly as the server counts it: regexp_split_to_array(btrim(body),
 * '\s+'). btrim strips SPACES only, so non-space edge whitespace (a leading
 * newline, say) yields an empty split field the server counts too; mirroring
 * that keeps client and proc in lockstep at the 50-word boundary. A body with
 * no content at all counts 0 (send is blocked before the proc's own empty
 * check could ever matter).
 */
export function countWords(body: string): number {
  if (body.trim() === '') return 0;
  const spaceTrimmed = body.replace(/^ +/, '').replace(/ +$/, '');
  return spaceTrimmed.split(/\s+/).length;
}

type CounterTone = 'hidden' | 'amber' | 'over';

/** Hidden below 35 words; amber 35..50; over (red, blocks send) above 50. */
export function counterTone(words: number): CounterTone {
  if (words > MAX_WORDS) return 'over';
  if (words >= COUNTER_FROM) return 'amber';
  return 'hidden';
}

/** Empty slots are ignored on send: send needs at least one slot with text and
 *  every slot with text at 1..50 words (the proc enforces the same rule). */
export function slotsSendable(bodies: readonly string[]): boolean {
  const filled = bodies.filter((body) => countWords(body) > 0);
  return filled.length > 0 && filled.every((body) => countWords(body) <= MAX_WORDS);
}

/** How many slots carry text, i.e. how many points a send writes. */
export function filledCount(bodies: readonly string[]): number {
  return bodies.filter((body) => countWords(body) > 0).length;
}

/** Build p_points: each slot's completed version ids ride with its own point;
 *  a slot with no attachments omits the key entirely. Empty slots are dropped. */
export function buildPoints(
  slots: readonly { body: string; attachmentVersionIds: readonly string[] }[],
): CheckpointPoint[] {
  return slots
    .filter((slot) => countWords(slot.body) > 0)
    .map((slot) =>
      slot.attachmentVersionIds.length > 0
        ? { body: slot.body, attachment_version_ids: [...slot.attachmentVersionIds] }
        : { body: slot.body },
    );
}

/** The send button label: "Send" for one checkpoint (or none typed yet),
 *  "Send N checkpoints" for more. */
export function sendLabel(count: number): string {
  return count <= 1 ? 'Send' : `Send ${count} checkpoints`;
}

/** The small ghost button under the slots that adds another slot. */
export const ADD_SLOT_LABEL = '+ Another';

/**
 * Each slot's checkpoint number: the post's next ledger_seq (startSeq) plus its
 * place, as the proc numbers the batch's points in order after the post's
 * highest ledger_seq. A slot with text is `open`; an empty one is the dashed
 * `next`. Pure.
 */
export function slotNumbers(
  bodies: readonly string[],
  startSeq: number,
): { n: number; state: 'open' | 'next' }[] {
  return bodies.map((body, index) => ({
    n: startSeq + index,
    state: countWords(body) > 0 ? 'open' : 'next',
  }));
}

type SubmitResult = { ok: true } | { ok: false; error: string };

interface SlotComposerProps {
  /** Write the whole batch; resolves ok to clear the slots, error to keep them. */
  onSubmit: (points: CheckpointPoint[]) => Promise<SubmitResult>;
  /** Whether the attach affordance is shown (endpoint configured + a workspace). */
  canAttach: boolean;
  /** Upload one picked file via the shared asset pipeline; never throws. */
  uploadFile?: (file: File) => Promise<ChatAttachmentUpload>;
  /**
   * The number the first new checkpoint takes: the post's highest ledger_seq
   * (every checkpoint row, deleted ones too, as comment_batch_create counts)
   * plus one. Absent: 1 (a post with no checkpoints yet).
   */
  startSeq?: number;
}

/** One slot: its draft body plus its own attachments (uploads and library picks). */
interface Slot {
  id: string;
  body: string;
  pending: Pending[];
  library: LibraryAsset[];
}

let slotSeq = 0;
let pendingSeq = 0;

function newSlot(): Slot {
  return { id: `slot-${(slotSeq += 1)}`, body: '', pending: [], library: [] };
}

export function SlotComposer({
  onSubmit,
  canAttach,
  uploadFile,
  startSeq = 1,
}: SlotComposerProps): ReactElement {
  const [slots, setSlots] = useState<Slot[]>(() => [newSlot()]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The library picker mounts on the first Assets tap only (nothing on paint),
  // then stays mounted so it can slide out.
  const [assetsMounted, setAssetsMounted] = useState(false);
  const [assetsOpen, setAssetsOpen] = useState(false);
  const layout = useChatLayout();
  const trayBaseId = useId();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);
  // The slot whose "+" opened the shared pickers (file, photo or library).
  const attachSlotId = useRef<string | null>(null);
  // Each slot's textarea, so its emoji button inserts at that slot's caret.
  const textareas = useRef(new Map<string, HTMLTextAreaElement>());

  // itemIn (docs/motion.md): a slot added after the first paint rises 8 px
  // into place, laid over its final state. The first slot never moves.
  const freshSlots = useFreshKeys(slots.map((slot) => slot.id));
  const slotEls = useRef(new Map<string, HTMLLIElement>());
  useLayoutEffect(() => {
    for (const id of freshSlots) itemIn(slotEls.current.get(id) ?? null);
  });

  const attachEnabled = canAttach && uploadFile !== undefined;
  const uploading = slots.some((slot) =>
    slot.pending.some((item) => item.status.state === 'uploading'),
  );
  const canSend = slotsSendable(slots.map((slot) => slot.body)) && !uploading && !submitting;
  const numbers = slotNumbers(slots.map((slot) => slot.body), startSeq);

  function updateBody(slotId: string, body: string): void {
    setSlots((prev) => prev.map((slot) => (slot.id === slotId ? { ...slot, body } : slot)));
  }

  // Only slots after the first are removable; their upload previews go with them.
  function removeSlot(slotId: string): void {
    setSlots((prev) => {
      const target = prev.find((slot) => slot.id === slotId);
      if (target === undefined || prev[0]?.id === slotId) return prev;
      for (const item of target.pending) {
        if (item.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
      }
      return prev.filter((slot) => slot.id !== slotId);
    });
    textareas.current.delete(slotId);
  }

  function addSlot(): void {
    setSlots((prev) => (prev.length >= MAX_POINTS ? prev : [...prev, newSlot()]));
  }

  // Photos is image-only (precheckImage); File takes the full allowlist.
  async function addFiles(slotId: string, list: FileList | null, imageOnly = false): Promise<void> {
    if (list === null || uploadFile === undefined) return;
    for (const file of Array.from(list)) {
      const id = `s-att-${(pendingSeq += 1)}`;
      const check = imageOnly ? precheckImage(file) : precheckFile(file);
      if (!check.ok) {
        const item: Pending = {
          id,
          file,
          previewUrl: null,
          status: { state: 'error', message: check.message },
          retryable: false,
        };
        setSlots((prev) =>
          prev.map((slot) =>
            slot.id === slotId ? { ...slot, pending: [...slot.pending, item] } : slot,
          ),
        );
        continue;
      }
      const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
      const item: Pending = { id, file, previewUrl, status: { state: 'uploading' } };
      setSlots((prev) =>
        prev.map((slot) =>
          slot.id === slotId ? { ...slot, pending: [...slot.pending, item] } : slot,
        ),
      );
      await uploadPending(slotId, id, file);
    }
  }

  // Upload one chip's file and settle its status; a failure keeps the chip
  // (with its file) so Retry can run it again (FT17).
  async function uploadPending(slotId: string, id: string, file: File): Promise<void> {
    if (uploadFile === undefined) return;
    const outcome = await uploadFile(file);
    setSlots((prev) =>
      prev.map((slot) =>
        slot.id !== slotId
          ? slot
          : {
              ...slot,
              pending: slot.pending.map((pendingItem) =>
                pendingItem.id === id
                  ? {
                      ...pendingItem,
                      status: outcome.ok
                        ? { state: 'done', versionId: outcome.versionId }
                        : { state: 'error', message: outcome.message },
                    }
                  : pendingItem,
              ),
            },
      ),
    );
  }

  function retryPending(slotId: string, pendingId: string): void {
    const target = slots
      .find((slot) => slot.id === slotId)
      ?.pending.find((item) => item.id === pendingId);
    if (target === undefined || !canRetryPending(target)) return;
    setSlots((prev) =>
      prev.map((slot) =>
        slot.id !== slotId
          ? slot
          : {
              ...slot,
              pending: slot.pending.map((item) =>
                item.id === pendingId ? { ...item, status: { state: 'uploading' } } : item,
              ),
            },
      ),
    );
    void uploadPending(slotId, pendingId, target.file);
  }

  function removePending(slotId: string, pendingId: string): void {
    setSlots((prev) =>
      prev.map((slot) => {
        if (slot.id !== slotId) return slot;
        const target = slot.pending.find((item) => item.id === pendingId);
        if (target?.previewUrl != null) URL.revokeObjectURL(target.previewUrl);
        return { ...slot, pending: slot.pending.filter((item) => item.id !== pendingId) };
      }),
    );
  }

  function addLibrary(slotId: string, picks: LibraryAsset[]): void {
    setSlots((prev) =>
      prev.map((slot) =>
        slot.id === slotId ? { ...slot, library: mergeLibraryPicks(slot.library, picks) } : slot,
      ),
    );
  }

  function removeLibrary(slotId: string, versionId: string): void {
    setSlots((prev) =>
      prev.map((slot) =>
        slot.id === slotId
          ? { ...slot, library: slot.library.filter((asset) => asset.versionId !== versionId) }
          : slot,
      ),
    );
  }

  // A slot's tray tile: Photos / File open the shared pickers, Assets the
  // library picker, each for that slot. Nothing opens while a send is on its way.
  function pickTile(slotId: string, id: TrayTileId): void {
    if (submitting) return;
    attachSlotId.current = slotId;
    if (id === 'photos') photoInputRef.current?.click();
    else if (id === 'file') fileInputRef.current?.click();
    else if (id === 'assets') {
      setAssetsMounted(true);
      setAssetsOpen(true);
    }
  }

  // One shared hidden input per kind: the change lands in the slot that opened it.
  function onPicked(list: FileList | null, imageOnly: boolean): void {
    const slotId = attachSlotId.current;
    attachSlotId.current = null;
    if (slotId !== null) void addFiles(slotId, list, imageOnly);
  }

  async function submit(): Promise<void> {
    if (!canSend) return;
    setSubmitting(true);
    setError(null);
    const points = buildPoints(
      slots.map((slot) => ({
        body: slot.body,
        attachmentVersionIds: attachmentIdsOf(slot.pending, slot.library),
      })),
    );
    const result = await onSubmit(points);
    if (result.ok) {
      for (const slot of slots) {
        for (const item of slot.pending) {
          if (item.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
        }
      }
      setSlots([newSlot()]);
      setSubmitting(false);
      return;
    }
    // Keep every slot (text + chips) so a failed write is not lost.
    setError(result.error);
    setSubmitting(false);
  }

  const sendButton = (
    <Button
      variant="primary"
      shape="round"
      aria-label={sendLabel(Math.max(1, filledCount(slots.map((slot) => slot.body))))}
      className="shrink-0"
      disabled={!canSend}
      busy={submitting}
      onClick={() => void submit()}
    >
      <IconSend size={ICON_SIZE.control} />
    </Button>
  );

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {slots.map((slot, index) => {
          const words = countWords(slot.body);
          const tone = counterTone(words);
          const number = numbers[index] ?? { n: startSeq + index, state: 'next' as const };
          const chipCount = slot.pending.length + slot.library.length;
          return (
            <li
              key={slot.id}
              ref={(el) => {
                if (el === null) slotEls.current.delete(slot.id);
                else slotEls.current.set(slot.id, el);
              }}
              // relative: the slot's "+" tray sits above this slot, across its width.
              className="relative flex flex-col gap-2"
            >
              {/* ui/Composer: "+", number, field, emoji, then Send on one row
                  (the comment composer's layout). A later slot holds its
                  remove X in the send column, so every field keeps one width. */}
              <ComposerFrame
                state={submitting && index === 0 ? { kind: 'sending' } : { kind: 'idle' }}
                leading={
                  <>
                    {attachEnabled ? (
                      <ComposerTray
                        layout={layout}
                        only={{ tiles: COMMENT_TRAY_TILES, trayId: `${trayBaseId}-${slot.id}` }}
                        onShownChange={warmAssetPicker}
                        onPick={(id) => pickTile(slot.id, id)}
                      />
                    ) : null}
                    <span
                      aria-hidden
                      data-slot-number={number.n}
                      className="flex h-11 shrink-0 items-center"
                    >
                      <CheckpointCircle n={number.n} state={number.state} />
                    </span>
                  </>
                }
                input={
                  <Textarea
                    formatting
                    compact
                    rows={1}
                    aria-label={`Checkpoint ${index + 1}`}
                    placeholder={index === 0 ? 'Add a checkpoint' : 'Add another checkpoint'}
                    value={slot.body}
                    disabled={submitting}
                    ref={(el) => {
                      if (el !== null) textareas.current.set(slot.id, el);
                      else textareas.current.delete(slot.id);
                    }}
                    onChange={(event) => updateBody(slot.id, event.target.value)}
                    className="min-w-0 flex-1 self-center"
                  />
                }
                side={
                  <CommentEmojiButton
                    disabled={submitting}
                    className={COMPOSER_SIDE}
                    onPick={(char) =>
                      insertIntoTextarea(
                        () => textareas.current.get(slot.id) ?? null,
                        slot.body,
                        char,
                        (next) => updateBody(slot.id, next),
                      )
                    }
                  />
                }
                send={
                  index === 0 ? (
                    sendButton
                  ) : (
                    <IconButton
                      label={`Remove checkpoint ${index + 1}`}
                      className={COMPOSER_SIDE}
                      disabled={submitting}
                      onClick={() => removeSlot(slot.id)}
                    >
                      <IconX size={ICON_SIZE.control} />
                    </IconButton>
                  )
                }
              />
              {tone !== 'hidden' ? (
                <span
                  className={cn(
                    'self-end pr-1 font-mono text-sm tabular-nums',
                    tone === 'over' ? 'text-bad' : 'text-warn',
                  )}
                >
                  {words}/{MAX_WORDS}
                </span>
              ) : null}
              {tone === 'over' ? (
                <p role="alert" className="text-sm text-bad">
                  {OVER_LIMIT_MESSAGE}
                </p>
              ) : null}
              {chipCount > 0 ? (
                <ul className="flex flex-wrap gap-2">
                  {slot.pending.map((item) => (
                    <PendingChip
                      key={item.id}
                      item={item}
                      onRemove={() => removePending(slot.id, item.id)}
                      onRetry={() => retryPending(slot.id, item.id)}
                    />
                  ))}
                  {slot.library.map((asset) => (
                    <LibraryChip
                      key={libraryChipKey(asset)}
                      asset={asset}
                      onRemove={() => removeLibrary(slot.id, asset.versionId)}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>

      {/* "+ Another" adds a slot under the last one: a 44 ghost on its own line. */}
      <div className="flex">
        <Button
          variant="ghost"
          className="min-h-11 min-w-11"
          data-add-slot=""
          disabled={submitting || slots.length >= MAX_POINTS}
          onClick={addSlot}
        >
          {ADD_SLOT_LABEL}
        </Button>
      </div>

      {error !== null ? <ErrorNote>{error}</ErrorNote> : null}

      {attachEnabled ? (
        <>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            className="sr-only"
            onChange={(event) => {
              onPicked(event.target.files, false);
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
              onPicked(event.target.files, true);
              event.target.value = '';
            }}
          />
        </>
      ) : null}

      {assetsMounted ? (
        <Suspense fallback={null}>
          <LazyAssetPicker
            open={assetsOpen}
            onClose={() => {
              setAssetsOpen(false);
              attachSlotId.current = null;
            }}
            onConfirm={(picks) => {
              const slotId = attachSlotId.current;
              if (slotId !== null) addLibrary(slotId, picks);
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
