import { createElement } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * The seven type roles (CLAUDE.md Design rules, Layout L9). Every text style in
 * a part comes from here; a part uses at most three. This file is the only
 * place leading-*, tracking-* or text-[..] may appear (eslint designRules).
 *
 * Sizes below are from 768 up. Under 768 (12 Nov 2026) the tokens carry the
 * thread sizes: title, heading, body and label 17/20, secondary 15/20.
 *
 *   display    28/34 600 tight     post title only
 *   title      15/20 600           bar titles (HeaderBar, page bars)
 *   heading    15/20 600           card, row, sheet and chat-card titles
 *   body       14/20 400           copy; phone inputs 16/22 (inputBody)
 *   secondary  13/18 400 fg-2      previews, hints, captions (one line, truncate)
 *   label      14/20 500           buttons, chips, tabs, badges
 *   meta       12/16 400 mono fg-3 times, dates, counts, durations, sizes
 *   section    12/16 600 uppercase tracked fg-2  section labels (CLAUDE.md Roles)
 */
export type TextRole =
  | 'display'
  | 'title'
  | 'heading'
  | 'body'
  | 'secondary'
  | 'label'
  | 'meta'
  | 'section';

export const TEXT_ROLE: Record<TextRole, string> = {
  display: 'text-3xl font-semibold tracking-tight',
  title: 'text-lg font-semibold',
  heading: 'text-lg font-semibold',
  body: 'text-base font-normal',
  secondary: 'truncate text-md font-normal text-fg-2',
  label: 'text-base font-medium',
  meta: 'font-mono text-sm font-normal tabular-nums text-fg-3',
  section: 'text-sm font-semibold uppercase tracking-label text-fg-2',
};

/**
 * The section label (CLAUDE.md Design rules: sm/600 uppercase tracking-label, 0.06em
 * fg-2), the same string as TEXT_ROLE.section, for call sites that compose a
 * class string. It is the one tracked style, kept here so no call site writes
 * tracking-*. SECTION_LABEL_INK is the same without the colour, for a label
 * that sets its own ink.
 */
export const SECTION_LABEL_INK = 'text-sm font-semibold uppercase tracking-label';
export const SECTION_LABEL = `${SECTION_LABEL_INK} text-fg-2`;

/**
 * A one-line box that cuts its own words with an ellipsis (a cut ui/Tag): the
 * line box is the tag's 20 height, so the words sit centred as they do in the
 * flex tag. Same size and weight; only the line box is named here.
 */
export const CUT_LINE = 'leading-[1.25rem]';

/** Body inside a text field: 16/22 on phone (iOS never zooms), 14/20 from md. */
export const INPUT_BODY = 'text-input md:text-base';

/**
 * A word too long for its line breaks inside itself instead of running off the
 * screen (11 Nov 2026), and counts as breakable when a row sizes itself. Body,
 * heading and title take it; a caller's truncate keeps cutting on one line
 * (the break is left off, so nothing changes there).
 */
export const BREAK_LONG_WORD = '[overflow-wrap:anywhere]';
const BREAKS: ReadonlySet<TextRole> = new Set<TextRole>(['body', 'heading', 'title']);
const TRUNCATES = /(^|\s)truncate(\s|$)/;

/** The class string for a role, merged with extra layout classes (last wins). */
export function textRole(role: TextRole, className?: string): string {
  const breaks = BREAKS.has(role) && !TRUNCATES.test(className ?? '');
  return cn(TEXT_ROLE[role], breaks && BREAK_LONG_WORD, className);
}

type TextTag = 'span' | 'p' | 'div' | 'h1' | 'h2' | 'h3' | 'time' | 'dt' | 'dd' | 'label';

interface TextProps extends Omit<HTMLAttributes<HTMLElement>, 'role'> {
  /** The type role. The ARIA role, when one is needed, goes in ariaRole. */
  role: TextRole;
  ariaRole?: HTMLAttributes<HTMLElement>['role'];
  as?: TextTag;
  children?: ReactNode;
  /** <time dateTime> passthrough. */
  dateTime?: string;
}

/**
 * <Text role="meta">2:14 PM</Text>. Renders a span by default; `as` picks the
 * element (h1/h2 for titles). Layout classes go in className.
 */
export function Text({ role, ariaRole, as = 'span', className, children, ...props }: TextProps) {
  return createElement(
    as,
    { ...props, role: ariaRole, className: textRole(role, className) },
    children,
  );
}
