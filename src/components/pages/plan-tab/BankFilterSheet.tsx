// The Bank's Filter and sort sheet (the toolbar's one IconButton): three
// lit cards on the grey sheet.
// - Buckets: All buckets, then each bucket (single pick, the pick is the ink
//   fill), then the add chip (dashed +) that turns into an inline Input
//   (Enter or the tick adds through createBucket and picks it; Esc cancels).
//   A chip shows its name only. A second tap on the picked chip, or a
//   long-press / right-click on any bucket chip, opens its menu: Rename
//   (inline in place, workspace_bucket_rename), Delete bucket last (a second
//   line "{n} ideas keep their other buckets" only when ideas use it). Phone:
//   the menu replaces the Buckets card's body in place (Back, then the two
//   rows), never a second Sheet over this one (one sheet, one dim); Esc or
//   Back returns to the chips. Laptop: ui/ActionMenu's popover anchored to
//   the chip. A delete hides the chip behind the Undo strip for UNDO_MS and
//   workspace_bucket_delete fires when the strip ends.
// - Sort: the four sorts, a tick on the current.
// - Show archived ideas: a switch (archived ideas only).
// - Untouched for 90 days: a switch (live ideas last active over 90 days ago).
// Footer: Done. A client never opens it with writes (no add, rename or delete).

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { ActionMenu, type ActionMenuItem } from '@/components/ui/ActionMenu';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { Switch } from '@/components/ui/Switch';
import {
  ICON_SIZE,
  IconCheck,
  IconChevronLeft,
  IconEdit,
  IconPlus,
  IconTrash,
} from '@/components/ui/icons';
import { useToast } from '@/components/ui/toast';
import { useMenuGesture } from '@/components/ui/useLongPress';
import { BUCKET_NAME_MAX, type BucketOption } from '@/lib/buckets';
import { useEscapeLayer } from '@/lib/escape-stack';
import { useIsLaptop } from '@/lib/use-is-laptop';
import type { BankSort } from '@/lib/chat/plans';
import { useUndoableAction } from '@/lib/use-undoable-action';
import {
  BANK_SORT_OPTIONS,
  UNTOUCHED_LABEL,
  bucketDeleteLine,
  type BankFilter,
} from './bank-parts';

/** The bucket writes the sheet needs (BankSurface's owner wires them to src/lib/buckets.ts). */
export interface BucketWrites {
  create: (
    name: string,
  ) => Promise<{ ok: true; bucket: BucketOption } | { ok: false; message: string }>;
  rename: (id: string, name: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** The real delete; runs when the Undo strip ends. Throws on failure (the chip comes back). */
  remove: (id: string) => Promise<void>;
  /** Ideas in a bucket (the delete line's count). */
  countIn: (id: string) => number;
}

const CARD = 'lit-card flex flex-col gap-3 rounded-xl border bg-panel p-4';
const LABEL = 'text-base font-medium text-fg';

export function BankFilterSheet(props: {
  open: boolean;
  onClose: () => void;
  filter: BankFilter;
  onFilter: (next: BankFilter) => void;
  buckets: readonly BucketOption[];
  /** Null for a client (read only). */
  writes: BucketWrites | null;
  /** The buckets list after an own write (add, rename, delete or its undo). */
  onBuckets: (next: BucketOption[]) => void;
}): ReactElement {
  const { filter } = props;
  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Filter and sort"
      footer={
        <div className="flex justify-end">
          <Button variant="primary" type="button" data-bank-filter-done="" onClick={props.onClose}>
            Done
          </Button>
        </div>
      }
    >
      <div data-bank-filter-sheet="" className="flex flex-col gap-3 bg-bg p-4">
        <section className={CARD}>
          <h3 className={LABEL}>Buckets</h3>
          <BucketChips
            buckets={props.buckets}
            picked={filter.bucketId}
            onPick={(id) => props.onFilter({ ...filter, bucketId: id })}
            writes={props.writes}
            onBuckets={props.onBuckets}
          />
        </section>
        <section className={CARD}>
          <h3 className={LABEL}>Sort</h3>
          <div role="radiogroup" aria-label="Sort" className="flex flex-col">
            {BANK_SORT_OPTIONS.map((o) => (
              <SortOption
                key={o.value}
                value={o.value}
                label={o.label}
                on={filter.sort === o.value}
                onPick={(sort) => props.onFilter({ ...filter, sort })}
              />
            ))}
          </div>
        </section>
        <section className={CARD}>
          <div className="flex items-center justify-between">
            <span className="text-base text-fg">Show archived ideas</span>
            <Switch
              checked={filter.archived}
              label="Show archived ideas"
              onChange={(archived) => props.onFilter({ ...filter, archived, review: false })}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-base text-fg">{UNTOUCHED_LABEL}</span>
            <Switch
              checked={filter.review}
              label={UNTOUCHED_LABEL}
              onChange={(review) => props.onFilter({ ...filter, review, archived: false })}
            />
          </div>
        </section>
      </div>
    </Sheet>
  );
}

function SortOption(props: {
  value: BankSort;
  label: string;
  on: boolean;
  onPick: (value: BankSort) => void;
}): ReactElement {
  return (
    <PressableRow
      type="button"
      flat
      role="radio"
      aria-checked={props.on}
      data-bank-sort={props.value}
      onClick={() => props.onPick(props.value)}
      className="flex items-center justify-between px-1 text-base text-fg"
    >
      {props.label}
      {props.on ? <IconCheck size={ICON_SIZE.inline} /> : null}
    </PressableRow>
  );
}

/** The bucket chips with add, rename and delete (single pick). */
export function BucketChips(props: {
  buckets: readonly BucketOption[];
  picked: string | null;
  onPick: (id: string | null) => void;
  writes: BucketWrites | null;
  onBuckets: (next: BucketOption[]) => void;
  /** The add sheet's multi pick: every picked id (then `picked` is ignored). */
  multi?: ReadonlySet<string>;
}): ReactElement {
  const toast = useToast().show;
  const undoable = useUndoableAction();
  const laptop = useIsLaptop();
  const chipsRef = useRef<HTMLDivElement>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const busy = useRef(false);
  const shown = props.buckets.filter((b) => !hidden.has(b.id));
  const multi = props.multi;

  const add = async (): Promise<void> => {
    const name = draft.trim();
    if (props.writes === null || busy.current) return;
    busy.current = true;
    const res = await props.writes.create(name);
    busy.current = false;
    if (!res.ok) {
      toast({ title: res.message, tone: 'error' });
      return;
    }
    props.onBuckets([...props.buckets, res.bucket]);
    props.onPick(res.bucket.id);
    setDraft('');
    setAdding(false);
  };
  const rename = async (id: string): Promise<void> => {
    const name = draft.trim();
    const before = props.buckets.find((b) => b.id === id);
    if (props.writes === null || before === undefined || busy.current) return;
    if (name === before.name) {
      setRenaming(null);
      return;
    }
    busy.current = true;
    const res = await props.writes.rename(id, name);
    busy.current = false;
    if (!res.ok) {
      toast({ title: res.message, tone: 'error' });
      return;
    }
    props.onBuckets(props.buckets.map((b) => (b.id === id ? { ...b, name } : b)));
    setRenaming(null);
    setDraft('');
  };
  const remove = (bucket: BucketOption): void => {
    const writes = props.writes;
    if (writes === null) return;
    setHidden((prev) => new Set([...prev, bucket.id]));
    if (props.picked === bucket.id) props.onPick(null);
    undoable.run({
      label: 'Bucket deleted',
      commit: async () => {
        await writes.remove(bucket.id);
        props.onBuckets(props.buckets.filter((b) => b.id !== bucket.id));
      },
      revert: () =>
        setHidden((prev) => {
          const next = new Set(prev);
          next.delete(bucket.id);
          return next;
        }),
    });
  };
  const keys = (
    event: KeyboardEvent<HTMLInputElement>,
    done: () => void,
    cancel: () => void,
  ): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      done();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  };
  const startRename = (bucket: BucketOption): void => {
    setMenuFor(null);
    setDraft(bucket.name);
    setRenaming(bucket.id);
  };
  const startDelete = (bucket: BucketOption): void => {
    setMenuFor(null);
    remove(bucket);
  };
  const menuItems = (bucket: BucketOption): ActionMenuItem[] => {
    const line = bucketDeleteLine(props.writes?.countIn(bucket.id) ?? 0);
    return [
      { id: 'rename', label: 'Rename', icon: IconEdit, onSelect: () => startRename(bucket) },
      {
        id: 'delete-bucket',
        label: 'Delete bucket',
        icon: IconTrash,
        tone: 'danger',
        ...(line !== null ? { description: line } : {}),
        onSelect: () => startDelete(bucket),
      },
    ];
  };

  // Phone: the open menu takes the card's body in place (no second Sheet).
  const inPlace = laptop ? null : (shown.find((b) => b.id === menuFor) ?? null);
  const backTo = useRef<string | null>(null);
  const closeInPlace = (): void => {
    backTo.current = menuFor;
    setMenuFor(null);
  };
  useEffect(() => {
    if (inPlace !== null || backTo.current === null) return;
    const id = backTo.current;
    backTo.current = null;
    chipsRef.current
      ?.querySelector<HTMLElement>(`[data-bank-bucket="${CSS.escape(id)}"]`)
      ?.focus();
  }, [inPlace]);
  if (inPlace !== null) {
    return (
      <BucketMenuInPlace
        bucket={inPlace}
        line={bucketDeleteLine(props.writes?.countIn(inPlace.id) ?? 0)}
        onBack={closeInPlace}
        onRename={() => startRename(inPlace)}
        onDelete={() => startDelete(inPlace)}
      />
    );
  }

  return (
    <div ref={chipsRef} data-bank-buckets="" className="flex flex-wrap items-center gap-2">
      {multi === undefined ? (
        <Chip
          label="All buckets"
          selected={props.picked === null}
          data-bank-bucket="all"
          onClick={() => props.onPick(null)}
        />
      ) : null}
      {shown.map((bucket) =>
        renaming === bucket.id ? (
          <InlineName
            key={bucket.id}
            value={draft}
            label="Bucket name"
            onChange={setDraft}
            onKeyDown={(e) =>
              keys(
                e,
                () => void rename(bucket.id),
                () => setRenaming(null),
              )
            }
            onDone={() => void rename(bucket.id)}
          />
        ) : (
          <BucketChip
            key={bucket.id}
            bucket={bucket}
            picked={multi !== undefined ? multi.has(bucket.id) : props.picked === bucket.id}
            canEdit={props.writes !== null && multi === undefined}
            laptop={laptop}
            menuOpen={menuFor === bucket.id}
            onMenu={(open) => setMenuFor(open ? bucket.id : null)}
            items={menuItems(bucket)}
            onPick={() => props.onPick(bucket.id)}
          />
        ),
      )}
      {props.writes !== null ? (
        adding ? (
          <InlineName
            value={draft}
            label="New bucket"
            onChange={setDraft}
            onKeyDown={(e) =>
              keys(
                e,
                () => void add(),
                () => setAdding(false),
              )
            }
            onDone={() => void add()}
          />
        ) : (
          <Chip
            label="Bucket"
            variant="add"
            data-bank-bucket-add=""
            dot={<IconPlus size={ICON_SIZE.inline} />}
            onClick={() => {
              setDraft('');
              setRenaming(null);
              setAdding(true);
            }}
          />
        )
      ) : null}
    </div>
  );
}

function BucketChip(props: {
  bucket: BucketOption;
  picked: boolean;
  canEdit: boolean;
  laptop: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  items: ActionMenuItem[];
  onPick: () => void;
}): ReactElement {
  const gesture = useMenuGesture(() => {
    if (props.canEdit) props.onMenu(true);
  });
  return (
    <span className="relative inline-flex">
      <Chip
        label={props.bucket.name}
        selected={props.picked}
        data-bank-bucket={props.bucket.id}
        {...(props.canEdit ? gesture.handlers : {})}
        onClick={() => {
          if (gesture.consumeClickSuppression()) return;
          // A second tap on the picked chip opens its menu.
          if (props.picked && props.canEdit) props.onMenu(true);
          else props.onPick();
        }}
      />
      {props.canEdit && props.laptop ? (
        // The popover measures this zero-height edge along the chip's bottom,
        // so it drops from the chip itself.
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 flex">
          <ActionMenu
            title={props.bucket.name}
            items={props.items}
            trigger={null}
            align="left"
            open={props.menuOpen}
            onOpenChange={props.onMenu}
          />
        </span>
      ) : null}
    </span>
  );
}

/**
 * Phone: the bucket's menu in the Buckets card's place (Back, Rename, Delete
 * bucket). Esc or Back returns to the chips, focus back on the chip.
 */
function BucketMenuInPlace(props: {
  bucket: BucketOption;
  line: string | null;
  onBack: () => void;
  onRename: () => void;
  onDelete: () => void;
}): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  useEscapeLayer(true, props.onBack);
  useEffect(() => {
    box.current?.querySelector<HTMLElement>('[data-bank-bucket-menu-back]')?.focus();
  }, []);
  return (
    <div
      ref={box}
      data-bank-bucket-menu={props.bucket.id}
      role="group"
      aria-label={props.bucket.name}
      className="flex flex-col"
    >
      <div className="flex items-center gap-2">
        <Button variant="link" type="button" data-bank-bucket-menu-back="" onClick={props.onBack}>
          <IconChevronLeft size={ICON_SIZE.inline} />
          Back
        </Button>
        <span className="min-w-0 flex-1 truncate text-right text-sm text-fg-2">
          {props.bucket.name}
        </span>
      </div>
      <PressableRow
        type="button"
        flat
        data-bank-bucket-menu-rename=""
        onClick={props.onRename}
        className="flex items-center gap-2 px-1 text-base text-fg"
      >
        <IconEdit size={ICON_SIZE.inline} />
        Rename
      </PressableRow>
      <PressableRow
        type="button"
        flat
        data-bank-bucket-menu-delete=""
        onClick={props.onDelete}
        className="flex items-center gap-2 px-1 py-2 text-base text-bad"
      >
        <IconTrash size={ICON_SIZE.inline} />
        <span className="flex min-w-0 flex-col text-left">
          <span>Delete bucket</span>
          {props.line !== null ? (
            <span data-bank-bucket-delete-line="" className="truncate text-sm text-fg-3">
              {props.line}
            </span>
          ) : null}
        </span>
      </PressableRow>
    </div>
  );
}

/** The inline name field (add or rename): Enter or the tick saves, Esc cancels. */
function InlineName(props: {
  value: string;
  label: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  onDone: () => void;
}): ReactElement {
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        autoFocus
        aria-label={props.label}
        data-bank-bucket-input=""
        value={props.value}
        maxLength={BUCKET_NAME_MAX}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={props.onKeyDown}
        className="w-40"
      />
      <IconButton label="Save" data-bank-bucket-save="" onClick={props.onDone}>
        <IconCheck size={ICON_SIZE.nav} />
      </IconButton>
    </span>
  );
}
