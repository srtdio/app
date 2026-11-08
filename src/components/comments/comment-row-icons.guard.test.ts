import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard (8 Nov 2026, comment action bar): the row under a comment's body
// (Reply / Reply privately / Copy) is gone. Copy and the Reply privately
// icon are dropped from comments (a tap on the author still opens the person
// card with the comment quoted); the bar carries Reply (IconReply), Resolve
// (IconResolve), To-do (IconTodo), Edit (IconEdit) and Delete (IconTrash),
// one icon per concept. IconReplyPrivately and IconCopy keep their meanings in
// the chat (message menu); IconCheckCircle stays select mode and
// IconTaskSquare the chat task list.

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const COMMENTS = source('./Comments.tsx');
const BAR = source('./CommentActionBar.tsx');
const ICONS = source('../ui/icons.tsx');

function iconBody(name: string): string {
  const start = ICONS.indexOf(`export function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  return ICONS.slice(start, ICONS.indexOf('\n}\n', start));
}

describe('comment row icon actions', () => {
  it('comments carry no Copy, no Reply privately and no ⋯ menu', () => {
    for (const src of [COMMENTS, BAR]) {
      expect(src).not.toContain('IconCopy');
      expect(src).not.toContain('ReplyPrivatelyButton');
      expect(src).not.toContain('IconReplyPrivately');
      expect(src).not.toContain('ActionMenu');
      expect(src).not.toContain('IconMore');
      expect(src).not.toMatch(/label="Copy"/);
    }
    expect(COMMENTS).not.toContain('data-comment-actions');
    expect(COMMENTS).not.toContain('data-comment-role');
  });

  it('the bar draws each action with its one icon', () => {
    expect(BAR).toContain('<IconReply size={ICON_SIZE.inline} />');
    expect(BAR).toContain('<IconResolve size={ICON_SIZE.inline} />');
    expect(BAR).toContain('<IconTodo size={ICON_SIZE.inline} />');
    expect(BAR).toContain('<IconEdit size={ICON_SIZE.inline} />');
    expect(BAR).toContain('<IconTrash size={ICON_SIZE.inline} />');
    expect(BAR).not.toContain('IconCheckCircle');
    expect(BAR).not.toContain('IconTaskSquare');
  });

  it('IconResolve is an open circle with a tick (never the select-mode CheckCircleIcon)', () => {
    const body = iconBody('IconResolve');
    expect(body).toContain('<Svg {...props}>');
    expect(body).toContain('d="M21.801 10A10 10 0 1 1 17 3.335"');
    expect(body).not.toContain('CheckCircleIcon');
    expect(iconBody('IconCheckCircle')).toContain('CheckCircleIcon');
  });

  it('IconTodo is a list with ticks, not the chat task square', () => {
    const body = iconBody('IconTodo');
    expect(body).toContain('d="m3 17 2 2 4-4"');
    expect(body).toContain('d="M13 12h8"');
    expect(body).not.toContain('<rect');
  });

  it('IconCopy stays two squares and Reply privately the bubble with an out-arrow (chat)', () => {
    expect(iconBody('IconCopy')).toContain('icon={Square2StackIcon}');
    const rp = iconBody('IconReplyPrivately');
    expect(rp).toContain('d="M16 22l5 -5"');
    expect(source('../chat/MessageActionMenu.tsx')).toContain(
      'icon: <IconReplyPrivately size={size} />',
    );
  });
});
