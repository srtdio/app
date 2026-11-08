import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Work-chat guards (8 Nov 2026): L1 everyone on the left with no bubbles, and
// L3 no quote-reply in the main chat. Source checks, so a regression shows at
// the line that brings it back.
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const THREAD = read('../components/chat/MessageThread.tsx');
const CHAT_TYPE = read('../components/chat/chat-type.ts');

describe('L1: no bubble classes in chat rows', () => {
  it('no own or peer bubble fill, light, tail or right-aligned own row', () => {
    for (const banned of [
      'bg-bubble-own',
      'lit-bubble-own',
      'lit-bubble-other',
      'BUBBLE_TAIL',
      'OWN_BUBBLE_CONTENT',
      "mine ? 'flex-row-reverse'",
      "mine && 'items-end'",
    ]) {
      expect(THREAD, banned).not.toContain(banned);
    }
    expect(CHAT_TYPE).not.toContain('BUBBLE_TAIL');
  });

  it('every group head carries the photo and the name line (DMs, groups, notes alike)', () => {
    expect(THREAD).toContain('const showMeta = head;');
    expect(THREAD).toContain('const gutter = !head;');
  });

  it('rows keep the long-press guard (no iOS text selection or callout)', () => {
    expect(CHAT_TYPE).toContain("NO_TOUCH_SELECT = 'select-none [-webkit-touch-callout:none]'");
    expect(THREAD).toMatch(
      /const rowClass = cn\(\s*'group flex items-start gap-2',\s*railRowClass\(rail, false\),\s*NO_TOUCH_SELECT,/,
    );
  });
});

describe('L3: no quote strip in the main composer', () => {
  /** The main chat's <Composer ...> element: from its key to the first self-close. */
  function mainComposer(): string {
    const at = THREAD.indexOf('key={channelKey}');
    expect(at).toBeGreaterThan(-1);
    return THREAD.slice(
      at,
      THREAD.indexOf('/>', THREAD.indexOf('composerShared(view === null)', at)),
    );
  }

  it('the main composer never takes a reply or its media', () => {
    const composer = mainComposer();
    expect(composer).not.toContain('reply: replyDraft');
    expect(composer).not.toContain('replyMedia');
    expect(composer).not.toContain('about: aboutPost');
  });

  it('a main-chat send is always top level', () => {
    expect(THREAD).toContain('const rooted = null;');
  });
});
