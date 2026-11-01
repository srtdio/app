import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSendKeydown } from '@/lib/chat/send-key';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

describe('isSendKeydown (moved from Composer, U10)', () => {
  it('plain Enter on a fine pointer sends', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: false, coarsePointer: false }),
    ).toBe(true);
  });

  it('Shift+Enter, IME composition and any Enter on a coarse pointer make a new line', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: true, isComposing: false, coarsePointer: false }),
    ).toBe(false);
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: true, coarsePointer: false }),
    ).toBe(false);
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: false, coarsePointer: true }),
    ).toBe(false);
    expect(
      isSendKeydown({ key: 'a', shiftKey: false, isComposing: false, coarsePointer: false }),
    ).toBe(false);
  });

  it('the chat Composer and the Plan item comment box both use this one rule', () => {
    const composer = read('components/chat/Composer.tsx');
    expect(composer).toContain("import { isSendKeydown } from '@/lib/chat/send-key';");
    expect(composer).not.toContain('export function isSendKeydown');
    const item = read('components/chat/PlanItemScreen.tsx');
    expect(item).toContain("import { isSendKeydown } from '@/lib/chat/send-key';");
  });
});
