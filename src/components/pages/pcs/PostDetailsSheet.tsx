// The post Details bottom sheet: the editable metadata surface reached by tapping
// the title sub-header. Each row is read-only for the client and tappable for the
// agency side. Bucket and Owner open picker sub-sheets (existing non-archived
// buckets, with the create sheet's inline "+ New bucket" form / active
// members); Due date is the app's DatePicker (as the create sheet uses). The
// platform and format ("Instagram · Carousel") sit on a read-only row at the
// top. Every write is a single
// postUpdate of ONE field, run by the page (which owns the trace + load
// refresh); this sheet only reports intent. Closing with an unsaved date or a
// typed bucket name asks first (Sheet's discard confirm), so nothing is dropped
// silently.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Result } from '@srtdio/rpc';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { DatePicker } from '@/components/ui/DatePicker';
import { Input } from '@/components/ui/Input';
import { Sheet } from '@/components/ui/Sheet';
import { IconChevronRight, IconLock } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { BUCKET_NAME_MAX, listBuckets, type BucketOption } from '@/lib/buckets';
import type { MemberOption } from '@/components/chat/member-picker';
import { targetDateFromInput, targetDateInputValue } from '@/components/pages/pcs/post-date';
import { formatDay } from '@/lib/display-date';

interface PostDetailsSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** The workspace's IANA zone: the target date is read and written as a day in it. */
  timeZone: string;
  isAgencySide: boolean;
  isClient: boolean;
  bucketId: string | null;
  ownerUserId: string | null;
  targetDate: string | null;
  /** Active workspace members, for the owner picker (loaded by the page). */
  memberOptions: MemberOption[];
  /**
   * The post's platform and format as one read-only line ("Instagram ·
   * Carousel"), built by the page from its labels. Absent or empty: no row.
   */
  platformFormat?: string;
  /** Resolved owner display name (never a raw uuid) and avatar. */
  ownerName: string;
  ownerAvatarUrl: string | null;
  onChangeBucket: (bucketId: string) => void;
  onChangeOwner: (ownerUserId: string) => void;
  /**
   * The instant to store for the picked day (noon of that day in the workspace
   * zone, see post-date.ts), or null when Clear removes the date.
   */
  onChangeTargetDate: (targetDate: string | null) => void;
  /**
   * Create a bucket by name (the page runs createBucket with its trace) and
   * resolve the new option; on success the sheet files the post under it. A
   * failure's message is already friendly copy. Absent: no "+ New bucket".
   */
  onCreateBucket?: (name: string) => Promise<Result<BucketOption>>;
  /**
   * Approved posts (3a): only the due date and the bucket stay editable, so the
   * owner row turns read-only. Absent or false: every agency row is editable.
   */
  lockedFields?: boolean;
}

/** The stored date as a day in the workspace zone, for read display. */
function formatDate(value: string | null, timeZone: string): string {
  if (value === null) return 'No date';
  return formatDay(value, timeZone, new Date());
}

/** The picker's last row, opening the inline new bucket form (as the create sheet does). */
export const NEW_BUCKET_LABEL = '+ New bucket';

/** A label/value row; tappable (with a chevron) only when an onTap is given. */
function DetailRow({
  label,
  value,
  onTap,
  locked = false,
}: {
  /** The row's label; empty keeps the label column blank so values stay aligned. */
  label: string;
  value: ReactNode;
  onTap?: (() => void) | undefined;
  /** Spec B4: an approved post's locked row shows a lock at its end. */
  locked?: boolean;
}) {
  if (onTap !== undefined) {
    return (
      <button
        type="button"
        onClick={onTap}
        className="flex w-full min-h-[44px] items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="w-24 shrink-0 text-xs text-fg-3">{label}</span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg">{value}</span>
        <span className="ml-auto shrink-0 text-fg-3">
          <IconChevronRight size={18} />
        </span>
      </button>
    );
  }
  return (
    <div className="flex w-full min-h-[44px] items-center gap-3 px-2 py-2">
      <span className="w-24 shrink-0 text-xs text-fg-3">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-fg">{value}</span>
      {locked ? (
        <span aria-hidden data-detail-row-lock="" className="ml-auto shrink-0 text-fg-3">
          <IconLock size={16} />
        </span>
      ) : null}
    </div>
  );
}

/** A colored bucket dot from data (color_hex), never a hardcoded UI literal. */
function BucketDot({ colorHex }: { colorHex: string }) {
  return (
    <span
      aria-hidden
      className="h-2.5 w-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: colorHex }}
    />
  );
}

export function PostDetailsSheet({
  open,
  onClose,
  workspaceId,
  timeZone,
  isAgencySide,
  isClient,
  bucketId,
  ownerUserId,
  targetDate,
  platformFormat,
  memberOptions,
  ownerName,
  ownerAvatarUrl,
  onChangeBucket,
  onChangeOwner,
  onChangeTargetDate,
  onCreateBucket,
  lockedFields = false,
}: PostDetailsSheetProps) {
  const [buckets, setBuckets] = useState<BucketOption[]>([]);
  const [picker, setPicker] = useState<'bucket' | 'owner' | null>(null);
  // Flow B 28: the picked day is a draft until Done; changing the input never
  // writes. It re-seeds from the stored date whenever the sheet opens or the
  // stored date changes (a save landed, or Clear).
  const storedDay = targetDateInputValue(targetDate, timeZone);
  const [dateDraft, setDateDraft] = useState(storedDay);
  useEffect(() => {
    if (open) setDateDraft(storedDay);
  }, [open, storedDay]);

  // An unsaved picked day: every close path but Done asks "Discard changes?".
  const dateDirty = isAgencySide && dateDraft !== '' && dateDraft !== storedDay;

  // The inline "+ New bucket" form inside the bucket picker.
  const [newBucketOpen, setNewBucketOpen] = useState(false);
  const [newBucketName, setNewBucketName] = useState('');
  const [newBucketBusy, setNewBucketBusy] = useState(false);
  const [newBucketError, setNewBucketError] = useState<string | null>(null);
  function resetNewBucket(): void {
    setNewBucketOpen(false);
    setNewBucketName('');
    setNewBucketBusy(false);
    setNewBucketError(null);
  }
  async function submitNewBucket(): Promise<void> {
    if (onCreateBucket === undefined || newBucketBusy) return;
    const name = newBucketName.trim();
    if (name === '' || name.length > BUCKET_NAME_MAX) {
      setNewBucketError('Use 1 to 40 characters.');
      return;
    }
    setNewBucketBusy(true);
    setNewBucketError(null);
    const result = await onCreateBucket(name).catch(
      (): Result<BucketOption> => ({
        ok: false,
        error: { code: 'unknown', message: "Couldn't create the bucket. Try again." },
      }),
    );
    setNewBucketBusy(false);
    if (!result.ok) {
      setNewBucketError(result.error.message);
      return;
    }
    const created = result.data;
    setBuckets((prev) => (prev.some((b) => b.id === created.id) ? prev : [...prev, created]));
    onChangeBucket(created.id);
    resetNewBucket();
    setPicker(null);
  }

  // Done: write the picked day once (only when it changed), then close.
  function done(): void {
    if (isAgencySide && dateDraft !== '' && dateDraft !== storedDay) {
      onChangeTargetDate(targetDateFromInput(dateDraft, timeZone));
    }
    onClose();
  }

  // Load the non-archived buckets whenever the sheet opens, for both the current
  // value (dot + name) and the picker list.
  useEffect(() => {
    if (!open) {
      setPicker(null);
      return;
    }
    let cancelled = false;
    setNewBucketOpen(false);
    setNewBucketName('');
    setNewBucketError(null);
    void listBuckets(supabase, workspaceId).then((result) => {
      if (!cancelled) setBuckets(result.ok ? result.data : []);
    });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId]);

  const currentBucket = buckets.find((b) => b.id === bucketId) ?? null;

  const bucketValue =
    currentBucket !== null ? (
      <>
        <BucketDot colorHex={currentBucket.colorHex} />
        <span className="truncate">{currentBucket.name}</span>
      </>
    ) : (
      <span className="text-fg-3">No bucket</span>
    );

  const ownerValue = (
    <>
      <Avatar
        name={ownerName}
        size="sm"
        {...(ownerAvatarUrl !== null ? { src: ownerAvatarUrl } : {})}
      />
      <span className="truncate">{ownerName}</span>
    </>
  );

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        title="Post details"
        dirty={dateDirty}
        footer={
          isAgencySide ? (
            <Button
              variant="primary"
              size="lg"
              className="ml-auto"
              data-details-done=""
              onClick={done}
            >
              Done
            </Button>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-1">
          {platformFormat !== undefined && platformFormat !== '' ? (
            <DetailRow
              label=""
              value={
                <span data-detail-platform-format="" className="truncate">
                  {platformFormat}
                </span>
              }
            />
          ) : null}
          <DetailRow
            label="Bucket"
            value={bucketValue}
            onTap={isAgencySide ? () => setPicker('bucket') : undefined}
          />
          <DetailRow
            label="Owner"
            value={ownerValue}
            onTap={isAgencySide && !lockedFields ? () => setPicker('owner') : undefined}
            locked={isAgencySide && lockedFields}
          />

          {isAgencySide ? (
            <div className="flex w-full min-h-[44px] items-center gap-3 px-2 py-2">
              <span className="w-24 shrink-0 text-xs text-fg-3">Due date</span>
              <div data-details-date="" className="min-w-0 flex-1">
                <DatePicker label="Due date" value={dateDraft} onChange={setDateDraft} />
              </div>
              {targetDate !== null ? (
                <button
                  type="button"
                  onClick={() => onChangeTargetDate(null)}
                  className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-md px-3 text-sm font-medium text-fg-2 transition-colors hover:bg-panel-2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  Clear
                </button>
              ) : null}
            </div>
          ) : (
            <DetailRow
              label="Due date"
              value={<span className="tabular-nums">{formatDate(targetDate, timeZone)}</span>}
            />
          )}

          {isClient ? (
            <p className="px-2 pt-2 text-xs text-fg-3">Only creators can change these.</p>
          ) : null}
        </div>
      </Sheet>

      <Sheet
        open={picker === 'bucket'}
        onClose={() => {
          resetNewBucket();
          setPicker(null);
        }}
        title="Choose a bucket"
        dirty={newBucketOpen && newBucketName.trim() !== ''}
        busy={newBucketBusy}
      >
        <div className="flex flex-col gap-1">
          {buckets.map((bucket) => (
            <button
              key={bucket.id}
              type="button"
              onClick={() => {
                onChangeBucket(bucket.id);
                resetNewBucket();
                setPicker(null);
              }}
              className="flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-fg transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <BucketDot colorHex={bucket.colorHex} />
              <span className="truncate">{bucket.name}</span>
              {bucket.id === bucketId ? (
                <span className="ml-auto shrink-0 text-xs text-accent">Selected</span>
              ) : null}
            </button>
          ))}
          {onCreateBucket !== undefined && !newBucketOpen ? (
            <button
              type="button"
              data-new-bucket-open=""
              onClick={() => {
                setNewBucketOpen(true);
                setNewBucketName('');
                setNewBucketError(null);
              }}
              className="flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-sm font-medium text-accent transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {NEW_BUCKET_LABEL}
            </button>
          ) : null}
          {onCreateBucket !== undefined && newBucketOpen ? (
            <div
              data-new-bucket=""
              className="mt-1 flex flex-col gap-2 rounded-md border border-border bg-panel-2 p-3"
            >
              <Input
                autoFocus
                aria-label="New bucket name"
                placeholder="Bucket name"
                value={newBucketName}
                maxLength={BUCKET_NAME_MAX}
                disabled={newBucketBusy}
                onChange={(event) => {
                  setNewBucketName(event.target.value);
                  setNewBucketError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    void submitNewBucket();
                  }
                }}
              />
              {newBucketError !== null ? (
                <p role="alert" data-new-bucket-error="" className="text-xs text-bad">
                  {newBucketError}
                </p>
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="lg"
                  variant="primary"
                  data-new-bucket-create=""
                  disabled={newBucketBusy}
                  onClick={() => void submitNewBucket()}
                >
                  {newBucketBusy ? 'Creating…' : 'Create'}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  variant="ghost"
                  disabled={newBucketBusy}
                  onClick={resetNewBucket}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </Sheet>

      <Sheet open={picker === 'owner'} onClose={() => setPicker(null)} title="Choose an owner">
        {memberOptions.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-fg-3">No active members to assign.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {memberOptions.map((member) => (
              <button
                key={member.userId}
                type="button"
                onClick={() => {
                  onChangeOwner(member.userId);
                  setPicker(null);
                }}
                className="flex w-full min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-fg transition-colors hover:bg-panel-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Avatar
                  name={member.displayName}
                  size="sm"
                  {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
                />
                <span className="truncate">{member.displayName}</span>
                {member.userId === ownerUserId ? (
                  <span className="ml-auto shrink-0 text-xs text-accent">Selected</span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </Sheet>
    </>
  );
}
