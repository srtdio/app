import { describe, expect, it } from 'vitest';
import { isSendKeydown, shouldShowMic } from '@/components/chat/Composer';

// The repo's vitest runs in the node environment with no @testing-library/react,
// so caret/DOM behaviour is not exercised here. Following the codebase pattern
// (see MentionInput.test.tsx), the send-decision is extracted to a pure
// predicate and that contract is unit tested: plain Enter sends; Shift+Enter,
// Enter during IME composition, and a coarse (touch-primary) pointer keep the
// default newline/compose behaviour.
describe('isSendKeydown', () => {
  it('sends on plain Enter', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: false, coarsePointer: false }),
    ).toBe(true);
  });

  it('does not send on Shift+Enter (newline)', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: true, isComposing: false, coarsePointer: false }),
    ).toBe(false);
  });

  it('does not send on Enter during IME composition', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: true, coarsePointer: false }),
    ).toBe(false);
  });

  it('does not send on Enter on a touch-primary (coarse pointer) device', () => {
    expect(
      isSendKeydown({ key: 'Enter', shiftKey: false, isComposing: false, coarsePointer: true }),
    ).toBe(false);
  });

  it('ignores other keys', () => {
    expect(
      isSendKeydown({ key: 'a', shiftKey: false, isComposing: false, coarsePointer: false }),
    ).toBe(false);
  });
});

// The trailing composer control swaps between the record-voice-note mic and the
// Send button. The mic shows only when attaching is possible and the composer is
// empty and idle; any text, attachment, shared post, active recording, or
// in-flight voice send falls back to Send.
describe('shouldShowMic', () => {
  const idle = {
    hasUpload: true,
    disabled: false,
    text: '',
    attachmentCount: 0,
    sharedPostCount: 0,
    recording: false,
    voiceBusy: false,
  };

  it('shows the mic on an empty, idle composer that can upload', () => {
    expect(shouldShowMic(idle)).toBe(true);
  });

  it('hides the mic when there is text', () => {
    expect(shouldShowMic({ ...idle, text: 'hello' })).toBe(false);
  });

  it('hides the mic when an attachment is pending', () => {
    expect(shouldShowMic({ ...idle, attachmentCount: 1 })).toBe(false);
  });

  it('hides the mic when a post is shared', () => {
    expect(shouldShowMic({ ...idle, sharedPostCount: 1 })).toBe(false);
  });

  it('hides the mic while recording', () => {
    expect(shouldShowMic({ ...idle, recording: true })).toBe(false);
  });

  it('hides the mic while a voice note is sending', () => {
    expect(shouldShowMic({ ...idle, voiceBusy: true })).toBe(false);
  });

  it('hides the mic when uploads are unavailable', () => {
    expect(shouldShowMic({ ...idle, hasUpload: false })).toBe(false);
  });
});
