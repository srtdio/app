// The post Details bottom sheet: the editable metadata surface reached by tapping
// the title sub-header. Each row is read-only for the client and tappable for the
// agency side. Bucket and Owner open picker sub-sheets (existing non-archived
// buckets / active members); Target date is a native date overlay; Origin is
// read-only for everyone. Every write is a single postUpdate of ONE field, run by
// the page (which owns the trace + load refresh); this sheet only reports intent.

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import { Sheet } from '@/components/ui/Sheet';
import { IconChevronRight } from '@/components/ui/icons';
import { supabase } from '@/lib/supabase';
import { listBuckets, type BucketOption } from '@/lib/buckets';
import type { MemberOption } from '@/components/chat/member-picker';

interface PostDetailsSheetProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  isAgencySide: boolean;
  isClient: boolean;
  bucketId: string | null;
  ownerUserId: string | null;
  targetDate: string | null;
  origin: string;
  /** Active workspace members, for the owner picker (loaded by the page). */
  memberOptions: MemberOption[];
  /** Resolved owner display name (never a raw uuid) and avatar. */
  ownerName: string;
  ownerAvatarUrl: string | null;
  onChangeBucket: (bucketId: string) => void;
  onChangeOwner: (ownerUserId: string) => void;
  onChangeTargetDate: (targetDate: string) => void;
}

/** Format a timestamp for read display, falling back to the raw value. */
function formatDate(value: string | null): string {
  if (value === null) return 'No date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Reduce a timestamp to the YYYY-MM-DD a native date input expects. */
function toDateInputValue(value: string | null): string {
  if (value === null) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}

function originLabel(origin: string): string {
  return origin === 'brief' ? 'From brief' : 'Direct';
}

/** A label/value row; tappable (with a chevron) only when an onTap is given. */
function DetailRow({
  label,
  value,
  onTap,
}: {
  label: string;
  value: ReactNode;
  onTap?: (() => void) | undefined;
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
  isAgencySide,
  isClient,
  bucketId,
  ownerUserId,
  targetDate,
  origin,
  memberOptions,
  ownerName,
  ownerAvatarUrl,
  onChangeBucket,
  onChangeOwner,
  onChangeTargetDate,
}: PostDetailsSheetProps) {
  const [buckets, setBuckets] = useState<BucketOption[]>([]);
  const [picker, setPicker] = useState<'bucket' | 'owner' | null>(null);

  // Load the non-archived buckets whenever the sheet opens, for both the current
  // value (dot + name) and the picker list.
  useEffect(() => {
    if (!open) {
      setPicker(null);
      return;
    }
    let cancelled = false;
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
      <Sheet open={open} onClose={onClose} title="Post details">
        <div className="flex flex-col gap-1">
          <DetailRow
            label="Bucket"
            value={bucketValue}
            onTap={isAgencySide ? () => setPicker('bucket') : undefined}
          />
          <DetailRow
            label="Owner"
            value={ownerValue}
            onTap={isAgencySide ? () => setPicker('owner') : undefined}
          />

          {isAgencySide ? (
            <div className="flex w-full min-h-[44px] items-center gap-3 px-2 py-2">
              <span className="w-24 shrink-0 text-xs text-fg-3">Target date</span>
              <input
                type="date"
                aria-label="Target date"
                value={toDateInputValue(targetDate)}
                onChange={(event) => {
                  if (event.target.value !== '') onChangeTargetDate(event.target.value);
                }}
                className="min-h-[44px] flex-1 rounded-md border border-border bg-panel-2 px-3 text-sm text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft"
              />
            </div>
          ) : (
            <DetailRow
              label="Target date"
              value={<span className="tabular-nums">{formatDate(targetDate)}</span>}
            />
          )}

          <DetailRow label="Origin" value={originLabel(origin)} />

          {isClient ? (
            <p className="px-2 pt-2 text-xs text-fg-3">Only the agency can change these.</p>
          ) : null}
        </div>
      </Sheet>

      <Sheet open={picker === 'bucket'} onClose={() => setPicker(null)} title="Choose a bucket">
        {buckets.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-fg-3">
            No buckets yet. Create them in Workspace settings.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {buckets.map((bucket) => (
              <button
                key={bucket.id}
                type="button"
                onClick={() => {
                  onChangeBucket(bucket.id);
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
          </div>
        )}
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
