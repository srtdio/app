import { describe, expect, it } from 'vitest';
import { isSendKeydown } from '@/components/chat/Composer';

// The repo's vitest runs in the node environment with no @testing-library/react,
// so caret/DOM behaviour is not exercised here. Following the codebase pattern
// (see MentionInput.test.tsx), the send-decision is extracted to a pure
// predicate and that contract is unit tested: plain Enter sends; Shift+Enter and
// Enter during IME composition keep the default newline/compose behaviour.
describe('isSendKeydown', () => {
  it('sends on plain Enter', () => {
    expect(isSendKeydown('Enter', false, false)).toBe(true);
  });

  it('does not send on Shift+Enter (newline)', () => {
    expect(isSendKeydown('Enter', true, false)).toBe(false);
  });

  it('does not send on Enter during IME composition', () => {
    expect(isSendKeydown('Enter', false, true)).toBe(false);
  });

  it('ignores other keys', () => {
    expect(isSendKeydown('a', false, false)).toBe(false);
  });
});
