// The chat composer on ui/Composer (ComposerFrame): one 44 row in every state,
// the reply / About / editing / Reply privately bars in the frame's strip above
// it, side buttons as bare circles, and the one hint ("Message" / "Reply").
// The full Composer needs the chat store, session and workspace; like
// Composer.test.tsx this pins its source contract and renders the frame with
// the composer's own parts (its bars, its buttons) in each state.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  AboutBar,
  composerPlaceholder,
  EDIT_PLACEHOLDER,
  EditingBar,
  recordingElapsed,
  ReplyBar,
} from '@/components/chat/Composer';
import { ComposerFrame, type ComposerState } from '@/components/ui/Composer';
import { Button } from '@/components/ui/Button';
import { ICON_SIZE, IconMic, IconSend, IconTrash } from '@/components/ui/icons';

const SRC = readFileSync(fileURLToPath(new URL('../Composer.tsx', import.meta.url)), 'utf8');

/** The JSX from `<WritingBox` to its closing `/>` (the composer's one box). */
const FRAME = SRC.slice(SRC.indexOf('<WritingBox'), SRC.indexOf('/>\n\n        <input'));

const STATES: ComposerState[] = [
  { kind: 'idle' },
  { kind: 'recording', elapsed: '0:07' },
  { kind: 'sending' },
  { kind: 'scheduling' },
];

function row(state: ComposerState, strip?: boolean): string {
  return renderToStaticMarkup(
    <form>
      <ComposerFrame
        state={state}
        strip={
          strip === true ? (
            <>
              <AboutBar post={null} onCancel={() => undefined} />
              <ReplyBar
                reply={{ authorName: 'Ann', quote: { id: 'm1', authorUserId: 'a', preview: 'hi' } }}
                viewerUserId="me"
                onCancel={() => undefined}
              />
            </>
          ) : undefined
        }
        leading={<button type="button" aria-label="Add attachment" data-plus="" />}
        discard={
          <Button type="button" variant="danger" shape="round" aria-label="Cancel recording">
            <IconTrash size={ICON_SIZE.control} />
          </Button>
        }
        input={<textarea aria-label="Message" placeholder={composerPlaceholder(false)} />}
        side={<button type="button" aria-label="Emoji" className="rounded-full" />}
        send={
          <Button
            type="submit"
            variant="primary"
            shape="round"
            aria-label="Send"
            busy={state.kind === 'sending' || state.kind === 'scheduling'}
          >
            <IconSend size={ICON_SIZE.control} />
          </Button>
        }
      />
    </form>,
  );
}

describe('chat Composer on ui/Composer', () => {
  it('renders through ui/WritingBox (chat mode), with no hand-built well left', () => {
    expect(SRC).toContain(
      "import { RowKey, RowSend, WritingBox } from '@/components/ui/WritingBox';",
    );
    expect(FRAME).toContain('mode="chat"');
    expect(FRAME).toContain('strip={');
    expect(FRAME).toContain('leading={');
    expect(FRAME).toContain('input={');
    expect(FRAME).toContain('pillEnd={');
    // The emoji is the box's own row key (the emoji sheet), not a side slot.
    expect(FRAME).not.toContain('side={');
    expect(FRAME).toContain('send={');
    expect(FRAME).toContain('discard={');
    // The old recording well, voice-busy row and hand-built spinners are gone.
    expect(SRC).not.toContain('border border-border-strong bg-panel-2 px-3 lit-tint');
    expect(SRC).not.toContain('Sending voice note…');
    expect(SRC).not.toContain('data-edit-spinner');
    expect(SRC).not.toContain('border-t-accent');
  });

  it('every state keeps the one row, the send slot and the 44 field', () => {
    for (const state of STATES) {
      const html = row(state);
      expect(html.match(/data-composer-row=""/g)).toHaveLength(1);
      expect(html).toContain(`data-composer-state="${state.kind}"`);
      expect(html).toContain('data-composer-field=""');
      expect(html).toContain('min-h-11');
      expect(html).toContain('aria-label="Send"');
    }
  });

  it('recording: the bin is a 44 danger circle on the left, send on the right, m:ss in the field', () => {
    const html = row({ kind: 'recording', elapsed: recordingElapsed(7) });
    expect(html).toContain('aria-label="Cancel recording"');
    expect(html).toContain('lit-btn-danger');
    expect(html).not.toContain('data-plus');
    expect(html).toContain('Recording');
    expect(html).toContain('0:07');
    expect(html.indexOf('Cancel recording')).toBeLessThan(html.indexOf('data-composer-field'));
    expect(html.indexOf('data-composer-field')).toBeLessThan(html.indexOf('aria-label="Send"'));
    // The source wires the same: the bin in discard, stop-and-send in send.
    expect(FRAME).toMatch(/variant="danger"\s+shape="round"\s+aria-label="Cancel recording"/);
    expect(FRAME).toContain("{ kind: 'recording', elapsed: recordingElapsed(recorder.seconds) }");
  });

  it('elapsed reads m:ss', () => {
    expect(recordingElapsed(0)).toBe('0:00');
    expect(recordingElapsed(7.9)).toBe('0:07');
    expect(recordingElapsed(65)).toBe('1:05');
    expect(recordingElapsed(750)).toBe('12:30');
    expect(recordingElapsed(Number.NaN)).toBe('0:00');
    expect(recordingElapsed(-3)).toBe('0:00');
  });

  it('sending and scheduling: the spinner sits in the round send slot', () => {
    for (const kind of ['sending', 'scheduling'] as const) {
      const html = row({ kind });
      expect(html).toContain('data-busy-arc');
      expect(html).toContain('rounded-full w-11 px-0');
    }
    expect(row({ kind: 'scheduling' })).toContain('Scheduling…');
    // Scheduling keeps the field mounted (its text and ref come back).
    expect(row({ kind: 'scheduling' })).toContain('aria-label="Message"');
    expect(FRAME).toContain('busy={editBusy}');
    expect(FRAME).toContain('<RowSend');
  });

  it('voice busy never collapses the row: the mic spins in the send slot', () => {
    expect(FRAME).toMatch(/aria-label="Sending voice note"[\s\S]{0,80}\bbusy\b/);
    expect(FRAME).toContain('voiceBusy || editBusy');
    const html = renderToStaticMarkup(
      <ComposerFrame
        state={{ kind: 'sending' }}
        input={<textarea aria-label="Message" />}
        send={
          <Button
            type="button"
            variant="primary"
            shape="round"
            aria-label="Sending voice note"
            busy
          >
            <IconMic size={ICON_SIZE.control} />
          </Button>
        }
      />,
    );
    expect(html).toContain('data-composer-row');
    expect(html).toContain('aria-label="Message"');
    expect(html).toContain('aria-busy="true"');
  });

  it('the reply and About bars stack in the strip, above the row', () => {
    const html = row({ kind: 'idle' }, true);
    expect(html.indexOf('data-composer-strip')).toBeLessThan(html.indexOf('data-composer-row'));
    expect(html.indexOf('data-about-bar')).toBeLessThan(html.indexOf('data-composer-row'));
    expect(html.indexOf('Cancel reply')).toBeLessThan(html.indexOf('data-composer-row'));
    expect(html).toContain('flex-col');
    // In the source: every bar is a child of the strip, none sits in the row.
    const strip = FRAME.slice(FRAME.indexOf('strip={'), FRAME.indexOf('state={'));
    for (const bar of ['<EditingBar', '<AboutBar', '<ReplyBar', '<PrivateReplyBar']) {
      expect(strip).toContain(bar);
    }
    expect(strip).toContain('data-reply-strip=""');
  });

  it('a strip with nothing in it takes no room', () => {
    const html = renderToStaticMarkup(
      <ComposerFrame strip={<>{null}</>} input={<textarea />} send={<button>Send</button>} />,
    );
    expect(html).toContain('empty:hidden');
    expect(html).toMatch(/data-composer-strip="" class="[^"]*"><\/div>/);
  });

  it('the editing bar rides the strip too', () => {
    const html = renderToStaticMarkup(
      <ComposerFrame
        strip={<EditingBar text="old" onCancel={() => undefined} />}
        input={<textarea />}
        send={<button>Save</button>}
      />,
    );
    expect(html.indexOf('Cancel editing')).toBeLessThan(html.indexOf('data-composer-row'));
  });

  it('the mic is a bare row key (pill on a phone, laptop card while empty); send is RowSend', () => {
    expect(SRC).toMatch(/<RowKey\s+label="Record voice note"/);
    expect(FRAME).toContain('pillEnd={showMic ? micKey : undefined}');
    expect(FRAME).toContain('showMic && laptopBox ? (');
  });

  it('the hint is "Message", "Reply" while replying; "Edit message" while editing', () => {
    expect(composerPlaceholder(false)).toBe('Message');
    expect(composerPlaceholder(false, true)).toBe('Reply');
    expect(composerPlaceholder(true)).toBe('Message');
    expect(composerPlaceholder(false, false, true)).toBe(EDIT_PLACEHOLDER);
  });

  it('keeps the tour and test hooks on its controls', () => {
    expect(FRAME).toContain('data-induction={INDUCTION_KEYS.chatHash}');
    expect(SRC).toContain('data-induction={INDUCTION_KEYS.chatMic}');
    expect(FRAME).not.toContain('data-schedule-chevron');
    expect(FRAME).toContain('onShownChange={setTrayShown}');
    expect(FRAME).toContain('formatting');
    expect(FRAME).toContain('compact');
    expect(FRAME).toContain('listEnter={false}');
  });
});
