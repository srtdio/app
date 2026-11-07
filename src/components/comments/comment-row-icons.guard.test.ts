import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard (3 Nov 2026): a comment row's Copy is icon-only (clipboard), and Copy
// is the clipboard everywhere (IconCopy); its accessible name stays "Copy".
// Post screen redo (7 Nov 2026): a comment row's action line carries Reply
// privately as an icon (IconUser, named "Reply privately") beside Copy; a tap
// on the author still opens the same card with the comment quoted.

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
    expect(button).toContain('<IconUser size={ICON_SIZE.inline} />');
    expect(source('../chat/PlanItemThread.tsx')).not.toContain('ReplyPrivatelyButton');
  });

  it('the row Copy is an IconButton labelled "Copy" with the clipboard icon', () => {
    expect(COMMENTS).toMatch(/<IconButton\s+type="button"\s+label="Copy"\s+data-row-action="copy"/);
    expect(COMMENTS).toContain('<IconCopy size={ICON_SIZE.inline} />');
  });

  it('IconCopy is the Heroicons ClipboardDocumentIcon', () => {
    const start = ICONS.indexOf('export function IconCopy(');
    expect(start).toBeGreaterThan(-1);
    const end = ICONS.indexOf('\n}\n', start);
    const body = ICONS.slice(start, end);
    expect(body).toContain('icon={ClipboardDocumentIcon}');
    expect(ICONS).not.toContain('DocumentDuplicateIcon');
  });
});
