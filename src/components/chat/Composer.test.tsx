import { describe, expect, it } from 'vitest';
import { isSendKeydown } from '@/components/chat/Composer';

// The repo's vitest runs in the node environment with no @testing-library/react,
// so caret/DOM behaviour is not exercised here. Following the codebase pattern
// (see MentionInput.test.tsx), the send-decision is extracted to a pure
// predicate and that contract is unit tested: plain Enter sends; Shift+Enter,
// Enter during IME composition, and a coarse (touch-primary) pointer keep the
// default newline/compose behaviour.
describe('isSendKeydown', () => {
  it('sends on plain Enter', () => {
    expect(isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: false, coarsePointer: false })).toBe(
      true,
    );
  });

  it('does not send on Shift+Enter (newline)', () => {
    expect(isSendKeydown({ key: 'Enter', shiftKey: true, isComposing: false, coarsePointer: false })).toBe(
      false,
    );
  });

  it('does not send on Enter during IME composition', () => {
    expect(isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: true, coarsePointer: false })).toBe(
      false,
    );
  });

  it('does not send on Enter on a touch-primary (coarse pointer) device', () => {
    expect(isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: false, coarsePointer: true })).toBe(
      false,
    );
  });

  it('ignores other keys', () => {
    expect(isSendKeydown({ key: 'a', shiftKey: false, isComposing: false, coarsePointer: false })).toBe(
      false,
    );
  });
});
