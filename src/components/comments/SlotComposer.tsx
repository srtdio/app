// The client checkpoint composer: numbered single-line slots that grow as
// typed, one point per slot, all sent in ONE comment_batch_create call. It
// replaces only the CLIENT-role TOP-LEVEL composer on posts; replies (any
// role), the agency composer, and brief comments keep the free-text
// CommentComposer untouched. Checkpoints carry no mentions, so a slot is a
// plain textarea, never MentionInput. Attachments reuse the existing comment
// attachment flow (uploadFile -> asset-upload worker, returning asset VERSION
// ids); each slot's completed version ids ride with that slot's point. The
// composer owns no trace and no write wrapper: it hands the points back
// through onSubmit and the panel mints one trace per batch.

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Textarea } from '@/components/ui/Textarea';
import { cn } from '@/lib/cn';
import { IconPaperclip } from '@/components/chat/AttachmentIcons';
import { precheckFile, UPLOAD_ACCEPT } from '@/lib/asset-upload';
import type { ChatAttachmentUpload } from '@/lib/chat/attachments';
import { PendingChip, doneVersionIds } from '@/components/comments/CommentComposer';
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
export const OVER_LIMIT_MESSAGE = 'Over 50 words. Split it into two points.';

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

export type CounterTone = 'hidden' | 'amber' | 'over';

/** Hidden below 35 words; amber 35..50; over (red, blocks send) above 50. */
export function counterTone(words: number): CounterTone {
  if (words > MAX_WORDS) return 'over';
  if (words >= COUNTER_FROM) return 'amber';
  return 'hidden';
}

/** Send needs every slot at 1..50 words (the proc enforces the same rule). */
export function slotsSendable(bodies: readonly string[]): boolean {
  return (
    bodies.length > 0 &&
    bodies.every((body) => {
      const words = countWords(body);
      return words >= 1 && words <= MAX_WORDS;
    })
  );
}

/** Build p_points: each slot's completed version ids ride with its own point;
 *  a slot with no attachments omits the key entirely. */
export function buildPoints(
  slots: readonly { body: string; attachmentVersionIds: readonly string[] }[],
): CheckpointPoint[] {
  return slots.map((slot) =>
    slot.attachmentVersionIds.length > 0
      ? { body: slot.body, attachment_version_ids: [...slot.attachmentVersionIds] }
      : { body: slot.body },
  );
}

/** The send button label: "Send N points" (singular at one). */
export function sendLabel(count: number): string {
  return `Send ${count} ${count === 1 ? 'point' : 'points'}`;
}

type SubmitResult = { ok: true } | { ok: false; error: string };

interface SlotComposerProps {
  /** Write the whole batch; resolves ok to clear the slots, error to keep them. */
  onSubmit: (points: CheckpointPoint[]) => Promise<SubmitResult>;
  /** Whether the attach affordance is shown (endpoint configured + a workspace). */
  canAttach: boolean;
  /** Upload one picked file via the shared asset pipeline; never throws. */
  uploadFile?: (file: File) => Promise<ChatAttachmentUpload>;
}

/** One slot: its draft body plus its own attachment upload lifecycle. */
interface Slot {
  id: string;
  body: string;
  pending: Pending[];
}

let slotSeq = 0;
let pendingSeq = 0;

function newSlot(): Slot {
  return { id: `slot-${(slotSeq += 1)}`, body: '', pending: [] };
}

export function SlotComposer({ onSubmit, canAttach, uploadFile }: SlotComposerProps): ReactElement {
  const [slots, setSlots] = useState<Slot[]>(() => [newSlot()]);
  // Entrance motion (opacity/translateY only): a freshly appended slot renders
  // one frame at opacity-0/translate-y-1, then transitions to rest.
  const [entered, setEntered] = useState<Set<string>>(() => new Set());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  // The slot whose paperclip opened the shared hidden file input.
  const attachSlotId = useRef<string | null>(null);

  useEffect(() => {
    const missing = slots.filter((slot) => !entered.has(slot.id));
    if (missing.length === 0) return;
    const raf = requestAnimationFrame(() => {
      setEntered((prev) => {
        const next = new Set(prev);
        for (const slot of missing) next.add(slot.id);
        return next;
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [slots, entered]);

  const attachEnabled = canAttach && uploadFile !== undefined;
  const uploading = slots.some((slot) =>
    slot.pending.some((item) => item.status.state === 'uploading'),
  );
  const canSend = slotsSendable(slots.map((slot) => slot.body)) && !uploading && !submitting;

  function updateBody(slotId: string, body: string): void {
    setSlots((prev) => prev.map((slot) => (slot.id === slotId ? { ...slot, body } : slot)));
  }

  function addSlot(): void {
    setSlots((prev) => (prev.length >= MAX_POINTS ? prev : [...prev, newSlot()]));
  }

  async function addFiles(slotId: string, list: FileList | null): Promise<void> {
    if (list === null || uploadFile === undefined) return;
    for (const file of Array.from(list)) {
      const id = `s-att-${(pendingSeq += 1)}`;
      const check = precheckFile(file);
      if (!check.ok) {
        const item: Pending = {
          id,
          file,
          previewUrl: null,
          status: { state: 'error', message: check.message },
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

  async function submit(): Promise<void> {
    if (!canSend) return;
    setSubmitting(true);
    setError(null);
    const points = buildPoints(
      slots.map((slot) => ({ body: slot.body, attachmentVersionIds: doneVersionIds(slot.pending) })),
    );
    const result = await onSubmit(points);
    if (result.ok) {
      for (const slot of slots) {
        for (const item of slot.pending) {
          if (item.previewUrl != null) URL.revokeObjectURL(item.previewUrl);
        }
      }
      setSlots([newSlot()]);
      setEntered(new Set());
      setSubmitting(false);
      return;
    }
    // Keep every slot (text + chips) so a failed write is not lost.
    setError(result.error);
    setSubmitting(false);
  }

  return (
    <div className="flex flex-col gap-2">
      <ol className="flex flex-col gap-2">
        {slots.map((slot, index) => {
          const words = countWords(slot.body);
          const tone = counterTone(words);
          return (
            <li
              key={slot.id}
              className={cn(
                'flex flex-col gap-1.5 transition-[opacity,transform] duration-200 ease-out',
                entered.has(slot.id) ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-1',
              )}
            >
              <div className="flex items-start gap-2">
                <span
                  aria-hidden
                  className="flex h-11 w-5 shrink-0 items-center justify-center text-xs font-medium tabular-nums text-fg-3"
                >
                  {index + 1}
                </span>
                <Textarea
                  autoGrow
                  rows={1}
                  aria-label={`Point ${index + 1}`}
                  placeholder={index === 0 ? 'Add a point' : 'Add another point'}
                  value={slot.body}
                  disabled={submitting}
                  onChange={(event) => updateBody(slot.id, event.target.value)}
                  className="min-w-0 flex-1"
                  style={{ minHeight: '44px' }}
                />
                {attachEnabled ? (
                  <IconButton
                    label={`Attach a file to point ${index + 1}`}
                    disabled={submitting}
                    onClick={() => {
                      attachSlotId.current = slot.id;
                      fileInputRef.current?.click();
                    }}
                  >
                    <IconPaperclip size={20} />
                  </IconButton>
                ) : null}
              </div>
              {tone !== 'hidden' ? (
                <span
                  className={cn(
                    'self-end pr-1 font-mono text-xs tabular-nums',
                    tone === 'over' ? 'text-bad' : 'text-warn',
                  )}
                >
                  {words}/{MAX_WORDS}
                </span>
              ) : null}
              {tone === 'over' ? (
                <p role="alert" className="pl-7 text-xs text-bad">
                  {OVER_LIMIT_MESSAGE}
                </p>
              ) : null}
              {slot.pending.length > 0 ? (
                <ul className="flex flex-wrap gap-2 pl-7">
                  {slot.pending.map((item) => (
                    <PendingChip
                      key={item.id}
                      item={item}
                      onRemove={() => removePending(slot.id, item.id)}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>

      <div className="flex items-center gap-3 flex-wrap">
        <Button
          size="lg"
          variant="ghost"
          className="min-w-[44px]"
          disabled={submitting || slots.length >= MAX_POINTS}
          onClick={addSlot}
        >
          Add point
        </Button>
        <Button
          size="lg"
          variant="primary"
          className="ml-auto min-w-[44px]"
          disabled={!canSend}
          onClick={() => void submit()}
        >
          {submitting ? 'Sending' : sendLabel(slots.length)}
        </Button>
      </div>

      {error !== null ? (
        <div role="alert" className="rounded-md border border-bad px-3 py-2 text-sm text-bad">
          {error}
        </div>
      ) : null}

      {attachEnabled ? (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={UPLOAD_ACCEPT}
          className="sr-only"
          onChange={(event) => {
            const slotId = attachSlotId.current;
            attachSlotId.current = null;
            if (slotId !== null) void addFiles(slotId, event.target.files);
            event.target.value = '';
          }}
        />
      ) : null}
    </div>
  );
}
