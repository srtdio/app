import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard (8 Nov 2026, CLAUDE.md Design rules): the comment action bar never
// shares the author name's line. The bar is absolute on the row's top edge,
// the row's columns sit under it (ROW_BAR_ROOM_CLASS), the name is one line
// (nowrap + truncate), and the header holds no bar and no flex-1 spacer.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const COMMENTS = read('../components/comments/Comments.tsx');
const BAR = read('../components/comments/CommentActionBar.tsx');

function block(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
  const to = src.indexOf(end, from + start.length);
  expect(to, `missing ${end}`).toBeGreaterThan(from);
  return src.slice(from, to);
}

describe('comment action bar never shares the name line', () => {
  it('the bar is absolute on the row, half above its top edge', () => {
    const cls = block(BAR, 'export const COMMENT_BAR_CLASS', ';');
    for (const want of ['absolute', 'right-0', 'top-0', '-translate-y-1/2']) {
      expect(cls).toContain(want);
    }
    expect(cls).not.toContain('self-start');
  });

  it('the header line holds no bar and no spacer', () => {
    const header = block(COMMENTS, 'data-comment-header=""', '</div>');
    expect(header).not.toContain('renderBar');
    expect(header).not.toContain('CommentActionBar');
    expect(header).not.toContain('flex-1');
  });

  it('the columns sit under the bar and the name stays on one line', () => {
    expect(COMMENTS).toContain("export const ROW_BAR_ROOM_CLASS = 'mt-4';");
    expect(COMMENTS).toContain('cn(LEAD_COLUMN_CLASS, ROW_BAR_ROOM_CLASS)');
    expect(COMMENTS).toContain("cn('min-w-0 flex-1', ROW_BAR_ROOM_CLASS)");
    const name = block(COMMENTS, 'data-comment-author=""', '</span>');
    expect(name).toContain('whitespace-nowrap');
    expect(name).toContain('truncate');
    expect(name).not.toContain('overflow-wrap');
  });

  it('the edited marker lives at the body end, not in the header', () => {
    const header = block(COMMENTS, 'data-comment-header=""', '</div>');
    expect(header).not.toContain('edited');
    expect(COMMENTS).toContain("export const EDITED_MARKER = '(edited)';");
  });
});
