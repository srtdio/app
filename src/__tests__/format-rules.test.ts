import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Formatting: saved free text renders through parseFormat, one-line previews
// use stripFormat, and post captions never format (CLAUDE.md Design rules).
const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

/** Every <Textarea ...> / <MentionInput ...> opening tag in a source, in order. */
function tags(src: string, name: 'Textarea' | 'MentionInput'): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  for (const m of src.matchAll(re)) {
    const start = m.index ?? 0;
    // The opening tag ends at the first '>' that closes a '/>' or a bare '>' at
    // brace depth 0.
    let depth = 0;
    let end = start;
    for (let i = start; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0 && src[i - 1] !== '=') {
        end = i;
        break;
      }
    }
    out.push(src.slice(start, end + 1));
  }
  return out;
}

const hasFormatting = (tag: string): boolean => /\sformatting(\s|=|\/?>)/.test(tag);

describe('format rules', () => {
  it('post captions never format: CreatePostSheet and PostDetailPage Textareas', () => {
    for (const rel of [
      'components/pages/CreatePostSheet.tsx',
      'components/pages/PostDetailPage.tsx',
    ]) {
      const found = tags(read(rel), 'Textarea');
      expect(found.length).toBeGreaterThan(0);
      for (const tag of found) expect(hasFormatting(tag)).toBe(false);
    }
  });

  it.each([
    'components/chat/Composer.tsx',
    'components/chat/PlanItemScreen.tsx',
    'components/chat/ConceptSheet.tsx',
    'components/pages/pcs/use-post-decisions.tsx',
    'components/pages/CreateBriefSheet.tsx',
    'components/pages/pipeline/StageMoveConfirm.tsx',
    'components/pages/plan-tab/BankAddSheet.tsx',
  ])('%s: every Textarea formats', (rel) => {
    const found = tags(read(rel), 'Textarea');
    expect(found.length).toBeGreaterThan(0);
    for (const tag of found) expect(hasFormatting(tag)).toBe(true);
  });

  it('caption boxes are WritingBox caption mode; sheet fields are field mode', () => {
    const modes = (rel: string): string[] =>
      [...read(rel).matchAll(/<WritingBox\s+mode="(\w+)"/g)].map((m) => m[1] ?? '');
    expect(modes('components/pages/CreatePostSheet.tsx')).toEqual(['caption', 'caption']);
    expect(modes('components/pages/PostDetailPage.tsx')).toEqual(['caption']);
    expect(modes('components/pages/CreateBriefSheet.tsx')).toEqual(['field']);
    expect(modes('components/chat/ConceptSheet.tsx')).toEqual(['field']);
    expect(modes('components/pages/plan-tab/BankAddSheet.tsx')).toEqual(['field']);
    // The plan comment box is the chat composer's box: comment mode, send in its row.
    expect(modes('components/chat/PlanItemScreen.tsx')).toEqual(['comment']);
  });

  it('the comment composer MentionInput formats', () => {
    const found = tags(read('components/comments/CommentComposer.tsx'), 'MentionInput');
    expect(found.length).toBeGreaterThan(0);
    for (const tag of found) expect(hasFormatting(tag)).toBe(true);
  });

  it('formatting is opt-in: Textarea and MentionInput default it off', () => {
    expect(read('components/ui/Textarea.tsx')).toContain('formatting = false');
    expect(read('components/comments/MentionInput.tsx')).toContain('formatting = false');
  });

  it('chat and comment bodies render through the formatting renderer', () => {
    expect(read('components/chat/message-body.tsx')).toContain('parseFormat(body)');
    // Blocks (lists, quotes) are the outer layer: whole bodies go through renderRich.
    expect(read('components/chat/message-body.tsx')).toContain('parseBlocks(body)');
    const thread =
      read('components/chat/MessageThread.tsx') + read('components/chat/MessageBubble.tsx');
    expect(thread).toContain('renderRich(body');
    // Plan, post and brief comments are drawn by chat's own bubble (MessageThread's
    // renderRich above) through the one shared row.
    expect(read('components/chat/ThreadCommentRow.tsx')).toContain('<MessageBubble');
    expect(read('components/chat/PlanItemThread.tsx')).toContain('<ThreadCommentRow');
    expect(read('components/comments/Comments.tsx')).toContain('<ThreadCommentRow');
    expect(read('components/pages/BriefDetailPage.tsx')).toMatch(/renderRich\(\s*brief\.objective/);
    expect(read('components/pages/BriefDetailPage.tsx')).toMatch(
      /renderRich\(\s*brief\.brand_requirements/,
    );
  });

  it('CLAUDE.md carries the rule and lists WritingBox', () => {
    const doc = readFileSync(fileURLToPath(new URL('../../CLAUDE.md', import.meta.url)), 'utf8');
    expect(doc).toContain(
      'Saved free text renders through parseFormat; one-line previews use stripFormat; post captions never format.',
    );
    expect(doc).toContain('ui/WritingBox');
  });
});
