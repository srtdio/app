// "Link a post" picker. The Sheet primitive (bottom sheet on phone, centred
// dialog at sm+), the PostPicker search field and row look. Existing posts
// only: there is no new post option. Search matches titles across every
// fixture post on every date. With no search: the concept's day first, then
// other dates newest first. One selection at a time; "Link this post" confirms.

import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { NoResults } from '@/components/ui/NoResults';
import { PressableRow } from '@/components/ui/PressableRow';
import { Sheet } from '@/components/ui/Sheet';
import { Tag } from '@/components/ui/Tag';
import { ICON_SIZE, IconCheck, IconSearch, IconText } from '@/components/ui/icons';
import { cn } from '@/lib/cn';
import { POSTS } from './fixtures';
import type { FixturePost } from './fixtures';
import { SECTION_LABEL, dayHeader, postLine, postMeta } from './shared';

/** The 48px post cover box (PostCover POST_COVER_BOX) with the text-post glyph. */
function PostThumb(): ReactElement {
  return (
    <span
      aria-hidden="true"
      className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-panel-3 text-fg-3"
    >
      <IconText size={ICON_SIZE.control} />
    </span>
  );
}

/** PostPicker.tsx LIST_CLASS. */
const LIST_CLASS =
  '-mx-[18px] flex max-h-[50vh] flex-col overflow-y-auto border-t border-border sm:max-h-none sm:min-h-0 sm:flex-1';

export const PICK_FIRST_HINT = 'Pick a post first.';

interface Section {
  key: string;
  label: string;
  rows: FixturePost[];
}

/** The default sections: same day first, then other dates newest first. Pure. */
export function defaultSections(posts: readonly FixturePost[], day: string): Section[] {
  const same = posts.filter((p) => p.dueDate === day);
  const other = posts
    .filter((p) => p.dueDate !== day)
    .sort((a, b) => b.dueDate.localeCompare(a.dueDate));
  return [
    { key: 'same', label: dayHeader(day), rows: same },
    { key: 'other', label: 'Other dates', rows: other },
  ].filter((s) => s.rows.length > 0);
}

/** Title search over every post, any date. Pure. */
export function searchPosts(posts: readonly FixturePost[], query: string): FixturePost[] {
  const q = query.trim().toLowerCase();
  return posts.filter((p) => p.title.toLowerCase().includes(q));
}

export function LinkPostPicker(props: {
  open: boolean;
  /** The linked post, pre-selected when the picker reopens. */
  current: string | null;
  conceptDate: string;
  onLink: (postId: string) => void;
  onClose: () => void;
}): ReactElement {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(props.current);
  const [hint, setHint] = useState(false);

  // Every open starts fresh: the current link pre-selected, no search, no hint.
  useEffect(() => {
    if (!props.open) return;
    setQuery('');
    setSelected(props.current);
    setHint(false);
  }, [props.open, props.current]);

  const searching = query.trim() !== '';
  const sections = useMemo<Section[]>(
    () =>
      searching
        ? [
            {
              key: 'matches',
              label: (() => {
                const n = searchPosts(POSTS, query).length;
                return n === 1 ? '1 match' : `${n} matches`;
              })(),
              rows: searchPosts(POSTS, query),
            },
          ]
        : defaultSections(POSTS, props.conceptDate),
    [searching, query, props.conceptDate],
  );
  const empty = searching && (sections[0]?.rows.length ?? 0) === 0;

  const confirm = (): void => {
    if (selected === null) {
      setHint(true);
      return;
    }
    props.onLink(selected);
  };

  return (
    <Sheet
      open={props.open}
      onClose={props.onClose}
      title="Link a post"
      fixedHeight
      footer={
        <div className="flex w-full flex-col gap-2">
          {hint ? (
            <p data-proto-hint="" role="status" className="text-base text-bad">
              {PICK_FIRST_HINT}
            </p>
          ) : null}
          <Button
            variant="primary"
            data-proto-confirm=""
            onClick={confirm}
            className="w-full"
          >
            Link this post
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 sm:min-h-0 sm:flex-1">
        <Field label="Search">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-3">
              <IconSearch size={ICON_SIZE.inline} />
            </span>
            <Input
              type="text"
              enterKeyHint="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search posts"
              aria-label="Search posts"
              data-proto-search=""
              className="pl-9"
            />
          </div>
        </Field>
        {empty ? (
          <NoResults query={query} filtersActive={false} onClear={() => setQuery('')} />
        ) : (
          <ul className={LIST_CLASS}>
            {sections.map((section) => (
              <li key={section.key} data-section={section.key}>
                <ul>
                  <li
                    className={cn(
                      'border-b border-border bg-panel-2 px-4 py-2',
                      section.key === 'matches'
                        ? 'text-sm font-medium text-fg-2'
                        : SECTION_LABEL,
                    )}
                  >
                    {section.key === 'same' ? (
                      <span className="font-mono tabular-nums">{section.label}</span>
                    ) : (
                      section.label
                    )}
                  </li>
                  {section.rows.map((post) => (
                    <PickerRow
                      key={post.id}
                      post={post}
                      active={selected === post.id}
                      onPick={() => {
                        setSelected(post.id);
                        setHint(false);
                      }}
                    />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

/** One post row: cover, title, "Text · 6 Nov", stage tag, and a check when picked. */
function PickerRow(props: {
  post: FixturePost;
  active: boolean;
  onPick: () => void;
}): ReactElement {
  const { post, active } = props;
  return (
    <li>
      <PressableRow
        type="button"
        aria-pressed={active}
        data-proto-row={post.id}
        onClick={props.onPick}
        flat
        className={cn(
          'flex items-center gap-3 border-b border-border px-4 py-3 mv-tint',
          active && 'bg-accent-soft ring-2 ring-inset ring-accent',
        )}
      >
        <PostThumb />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="min-w-0 truncate text-lg font-medium text-fg">{post.title}</span>
          <span className="truncate font-mono text-sm tabular-nums text-fg-2">
            {postMeta(post)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <Tag label={postLine(post.stage).label} dot={post.stage} />
          <span className={cn('w-[18px]', active ? 'text-accent' : 'invisible')}>
            <IconCheck size={ICON_SIZE.nav} />
          </span>
        </span>
      </PressableRow>
    </li>
  );
}
