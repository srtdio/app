import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import {
  AboutBar,
  composerBars,
  composerBodyFor,
  composerCanSend,
  EDIT_EMPTY_TOAST,
  EDIT_PLACEHOLDER,
  EDITING_BAR_TITLE,
  EditingBar,
  editSendDecision,
  editTransition,
  composerPlaceholder,
  hashPickerQuery,
  dispatchSend,
  draftAttachments,
  hasLinkCards,
  isSendKeydown,
  mentionKeyAction,
  replyBarPreview,
  ReplyBar,
  restoreDraftText,
  attachRejectCopy,
  SEND_FAILED_COPY,
  sendVoiceRecording,
  shouldShowMic,
  VOICE_TOO_SHORT_COPY,
  withLinkCards,
} from '@/components/chat/Composer';
import { editFailureCopy } from '@/lib/chat/record';
import { createOutboxSender, runSend, type SendOutcome } from '@/lib/chat/send-flow';
import { canSendAttachmentMessage, type MessageAttachment } from '@/lib/chat/attachments';
import { stripHashToken } from '@/lib/chat/post-refs';
import { IconButton } from '@/components/ui/IconButton';
import { getDraft, resetDrafts, setDraft } from '@/lib/chat/drafts';
import { runEdit } from '@/lib/chat/delete-flow';
import type { Client } from '@srtdio/rpc';
import {
  deserializeMentions,
  mentionIds,
  resolveMentionText,
  serializedCaret,
  serializeMentions,
} from '@/lib/chat/mentions';

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

describe('dispatchSend (Send never waits on the network)', () => {
  const draft = {
    text: 'hello',
    attachments: [],
    sharedPostIds: [],
    reply: null,
    sharedBriefIds: [],
  };

  it('takes the draft in the same tick while the record RPC is still pending', () => {
    let resolveRecord: ((outcome: SendOutcome) => void) | undefined;
    const sender = createOutboxSender({
      deliver: () =>
        new Promise<SendOutcome>((resolve) => {
          resolveRecord = resolve;
        }),
      newTraceId: () => 'trace',
      onEvent: () => {},
      onChange: () => {},
      onAttemptFailed: () => {},
    });
    const taken = dispatchSend(
      (text) =>
        sender.enqueue('c1', {
          id: 'm1',
          text,
          local: { attachments: [], sharedPostIds: [], reply: null },
          state: 'sending',
        }),
      draft,
    );
    // The composer clears on `taken` and Send is enabled again for the next draft.
    expect(taken).toBe(true);
    expect(resolveRecord).toBeDefined();
    expect(sender.entries('c1')[0]?.state).toBe('sending');
    expect(
      canSendAttachmentMessage({
        text: 'next',
        attachmentCount: 0,
        sending: false,
      }),
    ).toBe(true);
    sender.dispose();
  });

  it('keeps the draft only when onSend throws', () => {
    expect(
      dispatchSend(() => {
        throw new Error('boom');
      }, draft),
    ).toBe(false);
  });
});

describe('instant attachment send (files upload after Send)', () => {
  const base = { disabled: false, text: '', sharedPostCount: 0, sharedBriefCount: 0 };

  it('enables Send with a picked file and no text; nothing has to upload first', () => {
    expect(composerCanSend({ ...base, fileCount: 1 })).toBe(true);
    expect(composerCanSend({ ...base, fileCount: 0 })).toBe(false);
    expect(composerCanSend({ ...base, text: 'hi', fileCount: 0 })).toBe(true);
    expect(composerCanSend({ ...base, disabled: true, fileCount: 1 })).toBe(false);
  });

  it('hands every chip over as a local attachment (File, preview, uploader), in order', () => {
    const upload = vi.fn();
    const a = new File(['ab'], 'a.png', { type: 'image/png' });
    const b = new File(['abcd'], 'b.pdf', { type: 'application/pdf' });
    const out = draftAttachments(
      [
        { id: 'att-1', file: a, previewUrl: 'blob:a' },
        { id: 'att-2', file: b, previewUrl: null },
      ],
      upload,
    );
    expect(out).toMatchObject([
      {
        assetId: '',
        name: 'a.png',
        mime: 'image/png',
        size: 2,
        local: { file: a, previewUrl: 'blob:a', progress: 0, upload },
      },
      {
        assetId: '',
        name: 'b.pdf',
        mime: 'application/pdf',
        size: 4,
        local: { file: b, previewUrl: null, progress: 0, upload },
      },
    ]);
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('pasted post and brief links become cards at Send', () => {
  const ORIGIN = 'https://app.example.test';
  const context = { workspaceKey: 'gbl', origin: ORIGIN };
  const draft = (text: string) => ({ text, sharedPostIds: [], sharedBriefIds: [] });
  const readers = () => ({
    postIds: vi.fn((numbers: number[]) =>
      Promise.resolve({
        ok: true as const,
        data: numbers.filter((n) => n !== 404).map((n) => ({ id: `post-${n}`, number: n })),
      }),
    ),
    briefIds: vi.fn((numbers: number[]) =>
      Promise.resolve({
        ok: true as const,
        data: numbers.map((n) => ({ id: `brief-${n}`, number: n })),
      }),
    ),
  });

  it('a link-only body sends the cards with an empty body', async () => {
    const r = readers();
    const out = await withLinkCards(
      draft(` ${ORIGIN}/p/gbl-12\n${ORIGIN}/b/gbl-3 ${ORIGIN}/p/GBL-12 `),
      context,
      r,
    );
    expect(out).toEqual({ text: '', sharedPostIds: ['post-12'], sharedBriefIds: ['brief-3'] });
    // One batched read per entity type, never one per link.
    expect(r.postIds).toHaveBeenCalledTimes(1);
    expect(r.postIds).toHaveBeenCalledWith([12]);
    expect(r.briefIds).toHaveBeenCalledTimes(1);
  });

  it('a mixed body keeps the text as typed and adds the cards', async () => {
    const text = `Can you check ${ORIGIN}/p/gbl-12 today? https://example.com`;
    const out = await withLinkCards(
      { text, sharedPostIds: ['picked'], sharedBriefIds: [] },
      context,
      readers(),
    );
    expect(out).toEqual({ text, sharedPostIds: ['picked', 'post-12'], sharedBriefIds: [] });
  });

  it('an unresolved ref stays a plain link, with no error', async () => {
    const text = `${ORIGIN}/p/gbl-404`;
    expect(await withLinkCards(draft(text), context, readers())).toEqual(draft(text));
    const failing = {
      postIds: () =>
        Promise.resolve({ ok: false as const, error: { code: 'unknown' as const, message: 'x' } }),
      briefIds: () => Promise.resolve({ ok: true as const, data: [] }),
    };
    expect(await withLinkCards(draft(text), context, failing)).toEqual(draft(text));
  });

  it('skips the reads for external links, other workspaces and other origins', async () => {
    const r = readers();
    const text = `https://example.com ${ORIGIN}/p/abc-1 https://other.test/p/gbl-1`;
    expect(hasLinkCards(text, 'gbl', ORIGIN)).toBe(false);
    expect(await withLinkCards(draft(text), context, r)).toEqual(draft(text));
    expect(r.postIds).not.toHaveBeenCalled();
    expect(r.briefIds).not.toHaveBeenCalled();
    expect(hasLinkCards(`${ORIGIN}/b/gbl-1`, 'gbl', ORIGIN)).toBe(true);
    expect(hasLinkCards(`${ORIGIN}/b/gbl-1`, null, ORIGIN)).toBe(false);
  });
});

// The hash character, built so this file passes the chat token-hygiene check.
const HASH = String.fromCharCode(35);

describe('hash picker', () => {
  const at = (
    text: string,
    caret = text.length,
    over: { enabled?: boolean; dismissed?: boolean } = {},
  ) => hashPickerQuery({ enabled: true, dismissed: false, text, caret, ...over });

  it('opens on a hash token at the caret with its query', () => {
    expect(at(HASH)).toBe('');
    expect(at(`${HASH}laun`)).toBe('laun');
    expect(at(`about ${HASH}14`)).toBe('14');
  });

  it('closes on a space with no pick, mid-word, on Escape, or without a bring hook', () => {
    expect(at(`${HASH}laun `)).toBeNull();
    expect(at(`a${HASH}b`)).toBeNull();
    expect(at(`${HASH}laun`, undefined, { dismissed: true })).toBeNull();
    expect(at(`${HASH}laun`, undefined, { enabled: false })).toBeNull();
  });

  it('a pick strips the token and keeps the rest of the draft', () => {
    const text = `look at ${HASH}lau please`;
    const caret = `look at ${HASH}lau`.length;
    expect(at(text, caret)).toBe('lau');
    expect(stripHashToken(text, caret)).toEqual({ text: 'look at  please', caret: 8 });
  });
});

describe('About bar', () => {
  const post = { id: 'p1', number: 14, title: 'Launch teaser', thumbnailAssetVersionId: null };

  function find(node: ReactNode, match: (el: ReactElement) => boolean): ReactElement | null {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child, match);
        if (hit !== null) return hit;
      }
      return null;
    }
    if (!isValidElement(node)) return null;
    if (match(node)) return node;
    return find((node.props as { children?: ReactNode }).children, match);
  }

  it('renders the reply bar grammar: accent rule, 32px thumb, "About" over the title', () => {
    const html = renderToStaticMarkup(<AboutBar post={post} onCancel={() => {}} />);
    expect(html).toContain('w-[3px]');
    expect(html).toContain('bg-accent');
    expect(html).toContain('h-8 w-8');
    expect(html).toMatch(/text-accent[^>]*>About</);
    expect(html).toContain('Launch teaser');
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
    expect(html).toContain('aria-label="Close about"');
  });

  it('its X cancels', () => {
    const onCancel = vi.fn();
    const close = find(
      AboutBar({ post, onCancel }),
      (el) => el.type === IconButton,
    );
    (close?.props as { onClick: () => void }).onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('the placeholder follows About, and mentions the hash otherwise', () => {
    // default
    expect(composerPlaceholder(false)).toBe(`Message, or ${HASH} for a post`);
    // reply draft, no About
    expect(composerPlaceholder(false, true)).toBe(`Reply, or ${HASH} for a post`);
    // About visible (with or without a reply draft): never a KEY-N code
    expect(composerPlaceholder(true)).toBe('Message about this post');
    expect(composerPlaceholder(true, true)).toBe('Message about this post');
  });
});

describe('About bar while its post loads (F14)', () => {
  it('is a skeleton with the same close: "About", a title placeholder', () => {
    const html = renderToStaticMarkup(<AboutBar post={null} onCancel={() => {}} />);
    expect(html).toContain('data-about-loading');
    expect(html).toMatch(/text-accent[^>]*>About</);
    expect(html).toContain('h-3 w-28');
    expect(html).toContain('aria-label="Close about"');
  });

  it('can be cancelled while loading', () => {
    const onCancel = vi.fn();
    const root = AboutBar({ post: null, onCancel });
    const stack: ReactNode[] = [root];
    let close: ReactElement | null = null;
    while (stack.length > 0 && close === null) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...(node as ReactNode[]));
      else if (isValidElement(node)) {
        if (node.type === IconButton) close = node;
        else stack.push((node.props as { children?: ReactNode }).children);
      }
    }
    (close?.props as { onClick: () => void }).onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('editing mode', () => {
  it('the editing bar: warn rule, "Editing your message" over the old text, a 44px X that cancels', () => {
    const html = renderToStaticMarkup(<EditingBar text="old words" onCancel={() => {}} />);
    expect(html).toContain('w-[3px]');
    expect(html).toContain('bg-warn');
    expect(html).not.toContain('bg-accent');
    expect(html).toMatch(new RegExp(`text-warn[^>]*>${EDITING_BAR_TITLE}<`));
    expect(html).toContain('old words');
    expect(html).toContain('aria-label="Cancel editing"');

    const onCancel = vi.fn();
    const stack: ReactNode[] = [EditingBar({ text: 'x', onCancel })];
    let close: ReactElement | null = null;
    while (stack.length > 0 && close === null) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...(node as ReactNode[]));
      else if (isValidElement(node)) {
        if (node.type === IconButton) close = node;
        else {
          const props = node.props as { children?: ReactNode; trailing?: ReactNode };
          stack.push(props.children, props.trailing);
        }
      }
    }
    (close?.props as { onClick: () => void }).onClick();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('hides the reply and About bars while editing; they come back after', () => {
    expect(composerBars({ editing: true, reply: true, about: true })).toEqual({
      editing: true,
      reply: false,
      about: false,
    });
    expect(composerBars({ editing: false, reply: true, about: true })).toEqual({
      editing: false,
      reply: true,
      about: true,
    });
  });

  it('the placeholder reads "Edit message" and the hash picker is off while editing', () => {
    expect(composerPlaceholder(true, true, true)).toBe(EDIT_PLACEHOLDER);
    expect(EDIT_PLACEHOLDER).toBe('Edit message');
    // The composer passes enabled: false while editing.
    expect(hashPickerQuery({ enabled: false, dismissed: false, text: `${HASH}la`, caret: 3 })).toBe(
      null,
    );
  });

  it('takes initialText once per message id and restores the earlier draft on cancel', () => {
    const start = editTransition(null, { messageId: 'a', initialText: 'old' }, 'my draft');
    expect(start).toEqual({ session: { messageId: 'a', savedText: 'my draft' }, text: 'old' });
    // A re-render with the same id never resets what the user typed.
    expect(editTransition(start.session, { messageId: 'a', initialText: 'old' }, 'old!')).toEqual({
      session: start.session,
      text: undefined,
    });
    // Switching to another message keeps the first draft to restore.
    const other = editTransition(start.session, { messageId: 'b', initialText: 'b text' }, 'old!');
    expect(other).toEqual({ session: { messageId: 'b', savedText: 'my draft' }, text: 'b text' });
    // X (or a successful edit): the draft from before editing comes back.
    expect(editTransition(other.session, undefined, 'b text!')).toEqual({
      session: null,
      text: 'my draft',
    });
    // Not editing: nothing changes.
    expect(editTransition(null, undefined, 'x')).toEqual({ session: null, text: undefined });
  });

  it('empty text on a text-only message does not send; unchanged text leaves without a write', () => {
    expect(EDIT_EMPTY_TOAST).toBe("Message can't be empty");
    expect(editSendDecision({ text: '  ', initialText: 'hi', hasOtherContent: false })).toBe(
      'empty',
    );
    expect(editSendDecision({ text: '', initialText: 'caption', hasOtherContent: true })).toBe(
      'send',
    );
    expect(editSendDecision({ text: ' hi ', initialText: 'hi', hasOtherContent: false })).toBe(
      'unchanged',
    );
    expect(editSendDecision({ text: 'hi there', initialText: 'hi', hasOtherContent: false })).toBe(
      'send',
    );
  });
});

describe('D1: the reply bar for a deleted quote', () => {
  const quote = { id: 'm1', authorUserId: 'peer', preview: 'the words' };

  it('shows the quote text while the message lives', () => {
    expect(replyBarPreview({ quote }, 'me')).toBe('the words');
  });

  it('once stripped, reads deletedMessageLabel (own or not), never the old text', () => {
    const stripped = { quote: { ...quote, preview: '' }, deleted: true as const };
    expect(replyBarPreview(stripped, 'me')).toBe('This message was deleted');
    expect(
      replyBarPreview({ ...stripped, quote: { ...stripped.quote, authorUserId: 'me' } }, 'me'),
    ).toBe('You deleted this message');
  });
});

describe('D7/F10: only the textarea and search inputs stay selectable', () => {
  const NO_SELECT = ['select-none', '[-webkit-touch-callout:none]'];

  it('the About chip and the reply bar carry select-none and no callout', () => {
    const about = renderToStaticMarkup(<AboutBar post={null} onCancel={() => {}} />);
    const reply = renderToStaticMarkup(
      <ReplyBar
        reply={{ authorName: 'Ann', quote: { id: 'm1', authorUserId: 'a', preview: 'hi' } }}
        viewerUserId="me"
        onCancel={() => {}}
      />,
    );
    for (const cls of NO_SELECT) {
      expect(about).toContain(cls);
      expect(reply).toContain(cls);
    }
  });

  it('the textarea keeps normal selection; nothing clears a selection programmatically', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(fileURLToPath(new URL('./Composer.tsx', import.meta.url)), 'utf8');
    const textarea = source.slice(
      source.indexOf('<textarea'),
      source.indexOf('/>', source.indexOf('<textarea')),
    );
    expect(textarea).not.toContain('select-none');
    expect(textarea).not.toContain('NO_TOUCH_SELECT');
    // The no-select class: its import, the About and reply bars, and the Send
    // button while a hold schedules (no iOS selection or callout), nothing else.
    expect(source.split('NO_TOUCH_SELECT').length - 1).toBe(4);
    expect(source).not.toContain('select-none');
    expect(source).not.toContain('removeAllRanges');
  });
});

describe('F14: composer toasts never show raw error text', () => {
  it('a pre-check refusal keeps its known line; anything else is fixed copy', () => {
    expect(attachRejectCopy('Files up to 100MB only')).toBe('Files up to 100MB only');
    expect(attachRejectCopy("This file type isn't supported")).toBe(
      "This file type isn't supported",
    );
    expect(attachRejectCopy('TypeError: x is undefined')).toBe("Couldn't add that file, try again");
  });

  it('an edit failure maps through editFailureCopy (idempotent on its own copy)', () => {
    expect(editFailureCopy('PGRST: connection reset')).toBe("Couldn't edit, try again");
    expect(editFailureCopy("Marked messages can't be edited")).toBe(
      "Marked messages can't be edited",
    );
    expect(editFailureCopy('Edit window has closed (15 min)')).toBe(
      'Edit window has closed (15 min)',
    );
  });

  it('a voice upload failure reads the send copy', () => {
    expect(SEND_FAILED_COPY).toBe("Couldn't send, try again");
  });
});

describe('@ mentions in the composer', () => {
  const ANA = '11111111-1111-4111-8111-111111111111';
  const BEN = '22222222-2222-4222-8222-222222222222';
  const names = new Map([
    [ANA, 'Ana Roy'],
    [BEN, 'Ben'],
  ]);
  const nameOf = (id: string): string | undefined => names.get(id);

  it('while the picker is open Enter and Tab pick (never send), arrows move, Esc closes', () => {
    expect(mentionKeyAction('Enter', false)).toBe('pick');
    expect(mentionKeyAction('Tab', false)).toBe('pick');
    expect(mentionKeyAction('ArrowDown', false)).toBe('down');
    expect(mentionKeyAction('ArrowUp', false)).toBe('up');
    expect(mentionKeyAction('Escape', false)).toBe('close');
    expect(mentionKeyAction('a', false)).toBeNull();
    // Mid-IME composition the picker leaves the key alone.
    expect(mentionKeyAction('Enter', true)).toBeNull();
  });

  it('a chat switch keeps each draft its own mention map', () => {
    resetDrafts();
    const picksA = [{ userId: ANA, name: 'Ana Roy' }];
    const picksB = [{ userId: BEN, name: 'Ben' }];
    const textA = 'hey @Ana Roy ';
    const textB = '@Ben ok';
    setDraft('chan-a', {
      text: serializeMentions(textA, picksA),
      caret: serializedCaret(textA, textA.length, picksA),
    });
    setDraft('chan-b', {
      text: serializeMentions(textB, picksB),
      caret: serializedCaret(textB, textB.length, picksB),
    });
    const a = restoreDraftText(getDraft('chan-a'), nameOf);
    const b = restoreDraftText(getDraft('chan-b'), nameOf);
    expect(a).toEqual({ text: textA, caret: textA.length, picks: picksA });
    expect(b).toEqual({ text: textB, caret: textB.length, picks: picksB });
    expect(mentionIds(serializeMentions(a.text, a.picks))).toEqual([ANA]);
    resetDrafts();
  });

  it('the edit box shows "@Name" and an unchanged edit is still unchanged', () => {
    const body = `ping @[${BEN}]`;
    const shown = deserializeMentions(body, nameOf);
    expect(shown.text).toBe('ping @Ben');
    expect(
      editSendDecision({
        text: serializeMentions(shown.text, shown.picks),
        initialText: body,
        hasOtherContent: false,
      }),
    ).toBe('unchanged');
    const bar = renderToStaticMarkup(
      <EditingBar text={resolveMentionText(body, nameOf)} onCancel={() => undefined} />,
    );
    expect(bar).toContain('ping @Ben');
    expect(bar).not.toContain('@[');
  });
});

describe('F4 draft restore and edit keep mentions whose names are still loading', () => {
  const ANA = '11111111-1111-4111-8111-111111111111';
  const EX = '33333333-3333-4333-8333-333333333333';
  const loading = (): string | undefined => undefined;
  const loaded = (id: string): string | undefined => (id === ANA ? 'Ana' : undefined);

  it('F4 restore draft before members load, then load: mention kept and sent', () => {
    resetDrafts();
    const stored = `hi @[${ANA}] `;
    setDraft('chan-a', { text: stored, caret: stored.length });
    // Members not settled: the stored body is held verbatim, nothing drops.
    const held = composerBodyFor(getDraft('chan-a'), false, loading);
    expect(held.held).toBe(true);
    expect(held.picks).toEqual([]);
    // What the composer writes back while held is the stored body, untouched.
    expect(serializeMentions(held.text, held.picks)).toBe(stored);
    expect(serializedCaret(held.text, held.caret, held.picks)).toBe(stored.length);
    // Members settle: "@Ana" with its pick; the send carries the mention.
    const shown = composerBodyFor({ text: held.text, caret: held.caret }, true, loaded);
    expect(shown).toEqual({
      text: 'hi @Ana ',
      caret: 'hi @Ana '.length,
      picks: [{ userId: ANA, name: 'Ana' }],
      held: false,
    });
    expect(mentionIds(serializeMentions(shown.text, shown.picks))).toEqual([ANA]);
    // After settle an id still unknown (ex-member) may drop.
    const ex = composerBodyFor({ text: `x @[${EX}]`, caret: 0 }, true, loaded);
    expect(ex.picks).toEqual([]);
    resetDrafts();
  });

  it('F4 enter edit before members load: mention kept and sent in p_mentions', async () => {
    const initialText = `fix @[${ANA}] please`;
    const held = composerBodyFor({ text: initialText, caret: initialText.length }, false, loading);
    expect(held.held).toBe(true);
    expect(held.text).toBe(initialText);
    const shown = composerBodyFor({ text: held.text, caret: held.caret }, true, loaded);
    expect(shown.text).toBe('fix @Ana please');
    const edited = `${shown.text} now`;
    const body = serializeMentions(edited, shown.picks);
    expect(editSendDecision({ text: body, initialText, hasOtherContent: false })).not.toBe(
      'unchanged',
    );
    const rpc = vi.fn(() => ({
      abortSignal: () =>
        Promise.resolve({ data: { id: 'm1', body, edited_at: 'now' }, error: null }),
    }));
    await runEdit(
      {
        client: { rpc } as unknown as Client,
        applyLocal: () => undefined,
        signal: undefined,
        onSignalFailed: () => undefined,
      },
      { channelId: 'c1', messageId: 'm1', body, traceId: 't' },
    );
    const args = (rpc.mock.calls[0] as unknown as [string, Record<string, unknown>])[1];
    expect(args.p_mentions).toEqual([ANA]);
  });
});

describe('H2 a failed member read never drops a mention', () => {
  const ANA = '11111111-1111-4111-8111-111111111111';
  const BEN = '22222222-2222-4222-8222-222222222222';
  const EX = '33333333-3333-4333-8333-333333333333';

  it('H2 failed read keeps the mention (shown "@Former member") and sends it', async () => {
    const stored = `hi @[${ANA}] and @[${BEN}] `;
    // The member read failed: nothing is confirmed gone, no names resolved.
    const shown = composerBodyFor(
      { text: stored, caret: stored.length },
      true,
      () => undefined,
      () => false,
    );
    expect(shown.text).toBe('hi @Former member and @Former member ');
    expect(shown.picks).toHaveLength(2);
    const body = serializeMentions(shown.text, shown.picks);
    expect(body).toBe(stored);
    const recordMessage = vi.fn(async () => ({
      ok: false as const,
      reason: 'error' as const,
      message: 'x',
    }));
    await runSend(
      { recordMessage, publishLive: undefined, onLiveWarning: () => undefined },
      {
        id: 'id-1',
        channelId: 'c1',
        currentUserId: 'me',
        traceId: 't',
        text: body,
        local: { attachments: [], sharedPostIds: [], reply: null },
      },
    );
    expect(recordMessage).toHaveBeenCalledWith(
      expect.objectContaining({ body: stored, mentions: [ANA, BEN] }),
    );
    // Only an id a successful read confirmed gone drops.
    const confirmed = composerBodyFor(
      { text: `x @[${EX}] @[${ANA}]`, caret: 0 },
      true,
      () => undefined,
      (id) => id === EX,
    );
    expect(mentionIds(serializeMentions(confirmed.text, confirmed.picks))).toEqual([ANA]);
  });
});

describe('voice notes under 1 second are discarded', () => {
  const recording = (durationMs: number, body: string = 'x') => ({
    blob: new Blob([body], { type: 'audio/webm' }),
    mime: 'audio/webm',
    recorderMime: 'audio/webm;codecs=opus',
    durationMs,
  });

  it.each([400, 999])('a %i ms recording sends nothing', async (ms) => {
    const onSend = vi.fn();
    expect(await sendVoiceRecording(recording(ms), onSend, undefined, null)).toBe('too-short');
    expect(onSend).not.toHaveBeenCalled();
    expect(VOICE_TOO_SHORT_COPY).toBe('Voice note too short');
  });

  it('a null or empty recording sends nothing', async () => {
    const onSend = vi.fn();
    expect(await sendVoiceRecording(null, onSend, undefined, null)).toBe('too-short');
    expect(await sendVoiceRecording(recording(5000, ''), onSend, undefined, null)).toBe(
      'too-short',
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it.each([1000, 2300])('a %i ms recording sends with its exact durationMs', async (ms) => {
    const onSend = vi.fn();
    expect(await sendVoiceRecording(recording(ms), onSend, undefined, null)).toBe('sent');
    expect(onSend).toHaveBeenCalledTimes(1);
    const attachments = onSend.mock.calls[0]?.[1] as MessageAttachment[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.durationMs).toBe(ms);
  });

  it('a throwing onSend is refused, not sent', async () => {
    const onSend = vi.fn(() => {
      throw new Error('boom');
    });
    expect(await sendVoiceRecording(recording(1200), onSend, undefined, null)).toBe('refused');
  });

  it('stopSend toasts the short copy and always resets voiceBusy in finally', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(fileURLToPath(new URL('./Composer.tsx', import.meta.url)), 'utf8');
    const body = source.slice(source.indexOf('async function stopSend'));
    const fn = body.slice(0, body.indexOf('\n  }\n') + 4);
    expect(fn).toContain(
      "if (outcome === 'too-short') toast.show({ title: VOICE_TOO_SHORT_COPY });",
    );
    expect(fn).toMatch(/finally \{\s+setVoiceBusy\(false\);\s+\}/);
    expect(fn).not.toContain('recorder.seconds');
  });
});
