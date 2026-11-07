import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard (3 Nov 2026): a comment row's Copy is icon-only, and Copy is one icon
// everywhere (IconCopy); its accessible name stays "Copy".
// Post screen redo (7 Nov 2026): a comment row's action line carries Reply
// privately as an icon (named "Reply privately") beside Copy; a tap on the
// author still opens the same card with the comment quoted.
// Follow-up (7 Nov 2026): IconCopy is two squares (Heroicons Square2StackIcon);
// Reply privately is IconReplyPrivately (a bubble with an out-arrow), never
// the person icon.

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const COMMENTS = source('./Comments.tsx');
const ICONS = source('../ui/icons.tsx');

/** Every <Button ...>children</Button> body in a source file. */
function buttonChildren(src: string): string[] {
  return Array.from(src.matchAll(/<Button\b[^>]*>([\s\S]*?)<\/Button>/g), (m) => m[1] ?? '');
}

describe('comment row icon actions', () => {
  it('Comments.tsx never renders the visible text "Copy" or REPLY_PRIVATELY as a Button child', () => {
    for (const body of buttonChildren(COMMENTS)) {
      expect(body.trim()).not.toBe('Copy');
      expect(body).not.toMatch(/^\s*Copy\s*$/m);
      expect(body).not.toContain('{REPLY_PRIVATELY}');
    }
  });

  it('a comment row renders Reply privately as an icon, only where it is allowed', () => {
    expect(COMMENTS).toContain(
      '{privateReply !== null ? <ReplyPrivatelyButton draft={privateReply} /> : null}',
    );
    const button = source('./ReplyPrivatelyButton.tsx');
    expect(button).toContain('label={REPLY_PRIVATELY}');
    expect(button).toContain('data-row-action="reply-privately"');
    expect(button).toContain('<IconReplyPrivately size={ICON_SIZE.inline} />');
    expect(button).not.toContain('IconUser');
    expect(source('../chat/PlanItemThread.tsx')).not.toContain('ReplyPrivatelyButton');
  });

  it('the row Copy is an IconButton labelled "Copy" with the two-squares icon', () => {
    expect(COMMENTS).toMatch(/<IconButton\s+type="button"\s+label="Copy"\s+data-row-action="copy"/);
    expect(COMMENTS).toContain('<IconCopy size={ICON_SIZE.inline} />');
  });

  it('IconCopy is the Heroicons Square2StackIcon (two squares)', () => {
    const start = ICONS.indexOf('export function IconCopy(');
    expect(start).toBeGreaterThan(-1);
    const end = ICONS.indexOf('\n}\n', start);
    const body = ICONS.slice(start, end);
    expect(body).toContain('icon={Square2StackIcon}');
    expect(ICONS).not.toContain('ClipboardDocumentIcon');
    expect(ICONS).not.toContain('DocumentDuplicateIcon');
  });

  it('IconReplyPrivately is the bubble with an out-arrow, drawn in Svg (Tabler, MIT)', () => {
    const start = ICONS.indexOf('export function IconReplyPrivately(');
    expect(start).toBeGreaterThan(-1);
    const body = ICONS.slice(start, ICONS.indexOf('\n}\n', start));
    expect(body).toContain('<Svg {...props}>');
    expect(body).toContain('d="M16 22l5 -5"');
    expect(body).toContain('d="M21 21.5v-4.5h-4.5"');
    expect(ICONS).toContain('Tabler Icons message-circle-share (outline), MIT');
  });

  it('the chat message menu Reply privately row uses IconReplyPrivately', () => {
    const menu = source('../chat/MessageActionMenu.tsx');
    expect(menu).toContain('icon: <IconReplyPrivately size={size} />');
  });
});
