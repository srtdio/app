// @vitest-environment jsdom
// The catch-up reply is the app's one writing box (ui/WritingBox) with the
// real composer behaviour: comment cards get the comment composer's + tray
// (Photos, File, Assets) and no mic; chat cards get the mic; at rest the box
// is the pill (min-h-11, the hint centred) inset px-4 / pb-3 so it starts on
// the card's photo column; Send hands the screen a CatchUpSend and clears.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => false,
  useHoverPointer: () => false,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock('@/lib/session-context', () => ({
  useSession: () => ({ session: { user: { id: 'me' } } }),
}));
vi.mock('@/lib/chat/use-chat-attachments', () => {
  const files = {
    canAttach: true,
    presignEnabled: false,
    presignCache: {},
    uploadFile: async () => ({ ok: true, reused: false, versionId: 'ver-1' }),
    transcribe: async () => ({ ok: false, message: 'off' }),
    canTranscribe: false,
  };
  return { useChatAttachments: () => files, useCommentAttachments: () => files };
});
vi.mock('@/lib/workspace-members', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/workspace-members')>()),
  useMentionCandidates: () => ({
    candidates: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        name: 'Ann Lee',
        username: 'ann',
        role: 'client',
        avatarUrl: null,
      },
    ],
    loading: false,
    error: null,
  }),
}));

import {
  CATCH_UP_TRAY_TILES,
  CatchUpReply,
  catchUpBody,
  catchUpSendOf,
  candidateMember,
  type CatchUpReplyProps,
} from '@/components/catch-up/CatchUpReply';
import { COMMENT_TRAY_TILES } from '@/components/comments/CommentComposer';
import type { CatchUpSend } from '@/lib/catch-up/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const ANN = '11111111-1111-4111-8111-111111111111';

function mount(over: Partial<CatchUpReplyProps> = {}): {
  sent: CatchUpSend[];
  focus: boolean[];
} {
  const sent: CatchUpSend[] = [];
  const focus: boolean[] = [];
  act(() => {
    root?.render(
      <CatchUpReply
        hint="Reply"
        mode="comment"
        laptop={false}
        workspaceId="ws-1"
        target={{ kind: 'comment', entityType: 'post', entityId: 'p1', parentCommentId: null }}
        onSend={(send) => sent.push(send)}
        onFocusChange={(f) => focus.push(f)}
        {...over}
      />,
    );
  });
  return { sent, focus };
}

function q<T extends Element = HTMLElement>(sel: string): T | null {
  return document.querySelector<T>(sel);
}

function type(area: HTMLTextAreaElement, value: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  act(() => {
    setValue?.call(area, value);
    area.setSelectionRange(value.length, value.length);
    area.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('CatchUpReply: the shared writing box', () => {
  it('comment cards: ui/WritingBox in comment mode, the comment tray tiles, no mic', () => {
    mount();
    const box = q('[data-catch-up-reply] [data-writing-box]');
    expect(box?.dataset.mode).toBe('comment');
    expect(q('[data-catch-up-mic]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('aria-label="Record voice note"');
    expect(CATCH_UP_TRAY_TILES).toEqual(COMMENT_TRAY_TILES);
    // The + at rest opens the tray with exactly Photos, File and Assets.
    const plus = q<HTMLButtonElement>('[data-catch-up-reply] [data-plus]');
    expect(plus).not.toBeNull();
    act(() => plus?.click());
    const tiles = Array.from(document.querySelectorAll('[data-tray] [data-tray-tile]')).map(
      (el) => el.getAttribute('data-tray-tile'),
    );
    expect(tiles).toEqual(['photos', 'file', 'assets']);
  });

  it('chat cards: chat mode with the mic on the right of the pill', () => {
    mount({
      mode: 'chat',
      hint: 'Message Design',
      target: { kind: 'chat', channelId: 'c1', threadRootId: null },
    });
    expect(q('[data-catch-up-reply] [data-writing-box]')?.dataset.mode).toBe('chat');
    const mic = q('[data-catch-up-mic]');
    expect(mic).not.toBeNull();
    expect(mic?.querySelector('[aria-label="Record voice note"]')).not.toBeNull();
    // The mic is the pill's last key, after the field.
    const frame = q('[data-writing-frame]');
    const field = frame?.querySelector('[data-writing-field]');
    expect(field?.compareDocumentPosition(mic as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('at rest: the pill (min-h-11, rounded-full) with the hint centred, inset px-4 pb-3', () => {
    mount({ laptop: true });
    const form = q('[data-catch-up-reply]');
    expect(form?.className).toContain('px-4');
    expect(form?.className).toContain('pb-3');
    expect(form?.className).not.toContain('border-t');
    // restPill: the pill on a laptop too.
    expect(q('[data-writing-box]')?.dataset.shape).toBe('pill');
    const frame = q('[data-writing-frame]');
    expect(frame?.className).toContain('min-h-11');
    expect(frame?.className).toContain('items-center');
    expect(frame?.className).toContain('rounded-full');
    const area = q<HTMLTextAreaElement>('[data-catch-up-reply-input]');
    expect(area?.getAttribute('placeholder')).toBe('Reply');
    expect(area?.className).toContain('self-center');
    expect(area?.parentElement?.className).toContain('self-center');
  });

  it('Send hands the trimmed text with mentions as @[uuid] tokens, then clears', () => {
    const { sent } = mount();
    const area = q<HTMLTextAreaElement>('[data-catch-up-reply-input]');
    if (area === null) throw new Error('no field');
    type(area, '  thanks @ann  ');
    const send = q<HTMLButtonElement>('[data-row-send]');
    expect(send).not.toBeNull();
    act(() => send?.click());
    expect(sent).toEqual([
      { text: `thanks @[${ANN}]`, attachmentAssetIds: [], voice: null },
    ]);
    expect(q<HTMLTextAreaElement>('[data-catch-up-reply-input]')?.value).toBe('');
  });

  it('keeps the data hooks the screen reads', () => {
    mount();
    expect(q('[data-catch-up-reply]')).not.toBeNull();
    expect(q('[data-catch-up-reply-input]')).not.toBeNull();
  });
});

describe('CatchUpReply: pure rules', () => {
  it('catchUpSendOf waits for uploads and a kept note, and refuses an empty send', () => {
    expect(catchUpSendOf({ body: '', ids: [], uploading: false, voice: null })).toBeNull();
    expect(catchUpSendOf({ body: 'hi', ids: [], uploading: true, voice: null })).toBeNull();
    expect(
      catchUpSendOf({
        body: '',
        ids: [],
        uploading: false,
        voice: { state: 'uploading', durationMs: 4000 },
      }),
    ).toBeNull();
    expect(
      catchUpSendOf({
        body: '',
        ids: ['v1'],
        uploading: false,
        voice: { state: 'done', assetId: 'a1', durationMs: 4000 },
      }),
    ).toEqual({
      text: '',
      attachmentAssetIds: ['v1'],
      voice: { assetId: 'a1', durationMs: 4000 },
    });
  });

  it('catchUpBody turns picks and typed member usernames into tokens', () => {
    const member = candidateMember({
      id: ANN,
      name: 'Ann Lee',
      username: 'ann',
      role: 'client',
      avatarUrl: null,
    });
    expect(member).toEqual({
      userId: ANN,
      displayName: 'Ann Lee',
      avatarUrl: null,
      username: 'ann',
      role: 'client',
    });
    expect(catchUpBody('hey @Ann Lee ', [{ userId: ANN, name: 'Ann Lee' }], [])).toBe(
      `hey @[${ANN}]`,
    );
    expect(catchUpBody('cc @ann.', [], [member])).toBe(`cc @[${ANN}].`);
    expect(catchUpBody('cc @bob', [], [member])).toBe('cc @bob');
  });
});
