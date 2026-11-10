import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { PageHead } from '@/components/shell/PageHead';
import { SectionHeader } from '@/components/shell/SectionHeader';

export { SectionSelect } from '@/components/shell/SectionHeader';

/*
 * The one list-screen shell (10 Nov 2026): what sits under the top bar on a
 * list tab. Literal classes (the compiler needs them); named-sizes.test.ts
 * proves each equals its ui/layout constant (SCREEN_*), and the visual
 * suite's assertListScreenAxis measures them on the page.
 */

/** Top bar to the chip row: SCREEN_CHIPS_TOP (12). */
export const LIST_SCREEN_CHIPS_TOP = 'mt-3';
/** The chip row's leading pad: SCREEN_GUTTER_PHONE / SCREEN_GUTTER_LAPTOP. */
export const LIST_SCREEN_CHIPS_PAD = 'pl-4 md:pl-6';
/** The chip row's trailing pad with Select: its 44 box pulled out 12 (trailing rule). */
export const LIST_SCREEN_CHIPS_END_SELECT = 'pr-1 md:pr-3';
/** The chip row's trailing pad with no Select: the gutter. */
export const LIST_SCREEN_CHIPS_END = 'pr-4 md:pr-6';
/** Chip row to the first content row: SCREEN_CONTENT_TOP (16). */
export const LIST_SCREEN_CONTENT_TOP = 'pt-4';
/** The content's side gutter: SCREEN_GUTTER_PHONE / SCREEN_GUTTER_LAPTOP. */
export const LIST_SCREEN_GUTTER = 'px-4 md:px-6';
/** The lead strip (between chips and content): 12 under the chips, on the gutter. */
export const LIST_SCREEN_LEAD = 'pt-3';

export interface ListScreenChips {
  /** The filter chips; they scroll sideways under the pinned Select. */
  chips?: ReactNode;
  /** The visible Select (SectionSelect), pinned at the chip row's end. */
  select?: ReactNode;
  /** Pin the chip row under the top bar while the list scrolls. */
  stickyChips?: boolean;
  /** Test and tour hooks for the chip row's wrapper (e.g. data-pipeline-toolbar). */
  chipsHook?: Readonly<Record<`data-${string}`, string>>;
}

export interface ListScreenProps extends ListScreenChips {
  /** The screen's title: the sr-only h1 (PageHead hidden). */
  title: string;
  /** An optional strip between the chip row and the content (a count line, a hint). */
  lead?: ReactNode;
  /** The content: the list, its loading boxes, empty or error state. */
  children?: ReactNode;
  /** Load more and tail rows, on the gutter under the content. */
  footer?: ReactNode;
}

/**
 * The chip row as the shell draws it: SectionHeader with the shell's top gap
 * and side pads, in a [data-shell="chips"] wrapper. Pure.
 */
export function listScreenChipRow({
  chips,
  select,
  stickyChips = false,
  chipsHook,
}: ListScreenChips): ReactElement {
  return (
    <div data-shell="chips" {...chipsHook}>
      <SectionHeader
        {...(select !== undefined ? { select } : {})}
        stickyChildren={stickyChips}
        topClass={LIST_SCREEN_CHIPS_TOP}
        padClass={cn(
          LIST_SCREEN_CHIPS_PAD,
          select !== undefined ? LIST_SCREEN_CHIPS_END_SELECT : LIST_SCREEN_CHIPS_END,
        )}
      >
        {chips}
      </SectionHeader>
    </div>
  );
}

/**
 * A list tab under the top bar: the hidden title, the chip row, the 16 to the
 * first content, the side gutter, the content and its footer. A tab passes
 * its parts and never sets these spaces itself. Pure render: no data, no
 * effect, nothing waited on.
 */
export function ListScreen({
  title,
  chips,
  select,
  stickyChips,
  chipsHook,
  lead,
  children,
  footer,
}: ListScreenProps): ReactElement {
  return (
    <>
      <PageHead title={title} hidden />
      {listScreenChipRow({
        chips,
        select,
        ...(stickyChips !== undefined ? { stickyChips } : {}),
        ...(chipsHook !== undefined ? { chipsHook } : {}),
      })}
      {lead !== undefined && lead !== null && lead !== false ? (
        <div data-shell="lead" className={cn(LIST_SCREEN_LEAD, LIST_SCREEN_GUTTER)}>
          {lead}
        </div>
      ) : null}
      <div data-shell="content" className={cn(LIST_SCREEN_CONTENT_TOP, LIST_SCREEN_GUTTER)}>
        {children}
      </div>
      {footer !== undefined && footer !== null ? (
        <div data-shell="footer" className={LIST_SCREEN_GUTTER}>
          {footer}
        </div>
      ) : null}
    </>
  );
}
