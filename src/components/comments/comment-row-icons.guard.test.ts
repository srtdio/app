import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Guard (3 Nov 2026): a comment row's Reply privately and Copy are icon-only
// (person and clipboard), and Copy is the clipboard everywhere (IconCopy).
// Their accessible names stay "Reply privately" and "Copy".

function source(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

const COMMENTS = source('./Comments.tsx');
const REPLY_PRIVATELY_BUTTON = source('./ReplyPrivatelyButton.tsx');
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

  it('ReplyPrivatelyButton renders no Button, only the person IconButton', () => {
    expect(REPLY_PRIVATELY_BUTTON).not.toMatch(/<Button\b/);
    expect(REPLY_PRIVATELY_BUTTON).not.toContain('>{REPLY_PRIVATELY}<');
    expect(REPLY_PRIVATELY_BUTTON).toMatch(/<IconButton\b/);
    expect(REPLY_PRIVATELY_BUTTON).toContain('label={REPLY_PRIVATELY}');
    expect(REPLY_PRIVATELY_BUTTON).toContain('<IconUser size={ICON_SIZE.nav} />');
  });

  it('the row Copy is an IconButton labelled "Copy" with the clipboard icon', () => {
    expect(COMMENTS).toMatch(/<IconButton\s+type="button"\s+label="Copy"\s+data-row-action="copy"/);
    expect(COMMENTS).toContain('<IconCopy size={ICON_SIZE.nav} />');
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
