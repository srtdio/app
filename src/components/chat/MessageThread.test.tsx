import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// MessageThread's import graph pulls the message factory, which imports the real
// agora-chat browser SDK. Mock it so importing the module in node never touches
// browser globals or the network (mirrors ChatShell.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { Avatar } from '@/components/ui/Avatar';
import { leaveSelectionThen } from '@/lib/chat/forward';
import {
  bodyText,
  bubbleClass,
  bubbleMeta,
  BubbleMetaView,
  metaPlacement,
  MetaSpacer,
  FAILED_RETRY_CLASS,
  FailedLine,
  REACTION_BADGE_CLASS,
  REACTION_ROW_SPACE,
  bubbleStatus,
  bubbleTimeLabel,
  DayPill,
  dmHeaderLine,
  ForwardedLabel,
  hasAlbum,
  HEADER_TYPING,
  headerAvatarPresence,
  isLinkTarget,
  renderMessageBody,
  isVoiceOnly,
  isTranscribable,
  nextVoiceIds,
  keyOpensMenu,
  ABOUT_UNAVAILABLE_TOAST,
  aboutQuote,
  aboutReplyFor,
  bubbleChip,
  EDITED_LABEL,
  MessageBubble,
  messageTimeSource,
  rowSelection,
  createRowHold,
  createSelectionGesture,
  markOutcomeCopy,
  captureRowAnchor,
  createSelectionScroll,
  restoreRowAnchor,
  type AnchorList,
  type RowAnchor,
  BURIED_MARKERS_LIMIT,
  buriedMarkerCount,
  enterSelectionHistory,
  resetSelectionHistory,
  SELECTION_HISTORY_KEY,
  type SelectionHistoryWindow,
  cardRefsFor,
  replyWithFocus,
  forwardEntersSelection,
  selectionOnEntry,
  SELECTION_ROW_OFFSET,
  type RowSelection,
  SELECTED_ROW_TINT,
  tombstoneClass,
  OWN_BUBBLE_CONTENT,
  SwipeReplyIcon,
  THREAD_LIST_CLASS,
  threadListItems,
  threadLightbox,
  threadRows,
  ThreadHeaderIdentity,
  tickerBar,
  threadStripSlot,
  type ThreadRow,
  mentionClass,
  mentionsMe,
  profileNameOf,
  renderBodyWithMentions,
} from '@/components/chat/MessageThread';
import {
  ALL_MARK,
  mentionPickerRows,
  resolveMentionText,
  type MentionMember,
} from '@/lib/chat/mentions';
import { previewMentionText } from '@/components/chat/ChatStoreProvider';
import { ActivityCard } from '@/components/pages/activity/ActivityCard';
import { chatMentionPreview } from '@/components/pages/activity/data';
import { boldAllMentions, draftLine } from '@/components/chat/ChannelList';
import { MentionPicker } from '@/components/chat/MentionPicker';
import { renderToStaticMarkup as renderStrip } from 'react-dom/server';
import type { ChatMark } from '@/lib/chat/marks';
import { SelectCheckbox } from '@/components/chat/MarkBits';
import { roleLabel } from '@/components/pages/settings/members-data';
import {
  focusFirstMenuItem,
  menuClosesOnKey,
  messageMenuItems,
  runMenuItem,
} from '@/components/chat/MessageActionMenu';
import { focusComposerInput } from '@/components/chat/Composer';
import { createSwipeReplyController } from '@/lib/chat/swipe-reply';
import {
  createTalkAboutHold,
  holdFocusesOnFire,
  talkAboutThenFocus,
} from '@/components/chat/PostCard';
import { ReplyQuoteBox } from '@/components/chat/ReplyQuote';
import {
  BUBBLE_BODY_TYPE,
  BUBBLE_META_TYPE,
  DATE_PILL_TYPE,
  QUOTE_AUTHOR_TYPE,
  QUOTE_TEXT_TYPE,
  sized,
  type ChatLayout,
} from '@/components/chat/chat-type';
import { formatClockTime } from '@/lib/chat/time-format';
import { Link } from 'react-router-dom';
import { MessageAttachments } from '@/components/chat/MessageAttachments';
import type { MessageAttachment } from '@/lib/chat/attachments';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import {
  DELETED_OTHER_LABEL,
  DELETED_OWN_LABEL,
  markMessagesDeleted,
  type ThreadMessage,
} from '@/lib/chat/thread';
import { PostRefChip } from '@/components/chat/PostRefChip';
import { SharedPostCards } from '@/components/chat/PostCard';
import {
  admitRows,
  chipTargetFor,
  parentIndexOf,
  replyForSend,
  rowReady,
  type PageGate,
} from '@/lib/chat/post-refs';
import { runSend } from '@/lib/chat/send-flow';
import { sendMessageRecord } from '@/lib/chat/record';
import type { Client } from '@srtdio/rpc';

// MessageBubble is a pure, hook-free presentational component, so calling it
// directly returns its element tree without invoking child components (Avatar,
// SharedPostCards, ...). That keeps these assertions in the node test job with
// no DOM, exactly as ChatShell.test.tsx inspects ChatShell's returned element.
const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

const PROFILES: Map<string, ChatProfile> = new Map([
  ['peer-1', { userId: 'peer-1', displayName: 'Alice', avatarUrl: null }],
]);

const CREATED_AT = '2026-09-22T18:45:00.123456+00:00';

// The clock time follows the device locale's hour cycle, so expectations read
// the same formatter the bubble does.
const T_UTC = formatClockTime(CREATED_AT, 'UTC');
const T_KOLKATA = formatClockTime(CREATED_AT, 'Asia/Kolkata');

/** A string as a literal regex source. */
function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeMessage(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer-1',
    body: 'hello there',
    createdAt: CREATED_AT,
    time: Date.parse(CREATED_AT),
    provisionalTime: false,
    mine: false,
    attachments: [],
    sharedPostIds: [],
    sharedBriefIds: [],
    reply: null,
    state: 'sent',
    status: 'sent',
    reactions: [],
    ...over,
  };
}

function renderBubble(
  message: ThreadMessage,
  opts?: {
    isGroup?: boolean;
    head?: boolean;
    tail?: boolean;
    afterLabel?: boolean;
    showTicks?: boolean;
    timeZone?: string;
    onRetry?: (id: string) => void;
    onCancelUpload?: (id: string) => void;
    layout?: ChatLayout;
    viewerUserId?: string;
    onTranscribe?: () => void;
  },
): ReactElement {
  return MessageBubble({
    message,
    profiles: PROFILES,
    cache,
    presignEnabled: false,
    showTicks: opts?.showTicks ?? false,
    isGroup: opts?.isGroup ?? false,
    head: opts?.head ?? true,
    tail: opts?.tail ?? true,
    ...(opts?.afterLabel !== undefined ? { afterLabel: opts.afterLabel } : {}),
    timeZone: opts?.timeZone ?? 'UTC',
    layout: opts?.layout ?? 'touch',
    ...(opts?.viewerUserId !== undefined ? { viewerUserId: opts.viewerUserId } : {}),
    onBadgeClick: () => {},
    ...(opts?.onRetry !== undefined ? { onRetry: opts.onRetry } : {}),
    ...(opts?.onCancelUpload !== undefined ? { onCancelUpload: opts.onCancelUpload } : {}),
    ...(opts?.onTranscribe !== undefined ? { onTranscribe: opts.onTranscribe } : {}),
  });
}

/** Walk the element tree depth-first, yielding every React element. */
function walk(node: ReactNode, visit: (el: ReactElement) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isValidElement(node)) return;
  visit(node);
  // The shared quote box is hook-free: expand it so its spans are walkable.
  if (node.type === ReplyQuoteBox) {
    walk(ReplyQuoteBox(node.props as Parameters<typeof ReplyQuoteBox>[0]), visit);
    return;
  }
  walk((node.props as { children?: ReactNode }).children, visit);
}

function hasAvatar(root: ReactElement): boolean {
  let found = false;
  walk(root, (el) => {
    if (el.type === Avatar) found = true;
  });
  return found;
}

function allText(root: ReactElement): string {
  const parts: string[] = [];
  walk(root, (el) => {
    const child = (el.props as { children?: ReactNode }).children;
    if (typeof child === 'string') parts.push(child);
  });
  return parts.join(' ');
}

function rootClass(root: ReactElement): string {
  return (root.props as { className?: string }).className ?? '';
}

describe('MessageBubble WhatsApp-style layout', () => {
  it('renders own messages right-aligned with no avatar and no sender name', () => {
    const root = renderBubble(makeMessage({ mine: true, senderUserId: 'me' }));
    expect(rootClass(root)).toContain('flex-row-reverse');
    expect(hasAvatar(root)).toBe(false);
    expect(allText(root)).not.toContain('You');
  });

  it('renders a DM peer message with no avatar and no sender name', () => {
    const root = renderBubble(makeMessage({ mine: false }), { isGroup: false });
    expect(hasAvatar(root)).toBe(false);
    expect(allText(root)).not.toContain('Alice');
  });

  it('renders a group run head with the avatar and sender name', () => {
    const root = renderBubble(makeMessage({ mine: false }), { isGroup: true, head: true });
    expect(hasAvatar(root)).toBe(true);
    expect(allText(root)).toContain('Alice');
  });

  it('tucks a group non-head message with no avatar and no sender name', () => {
    const root = renderBubble(makeMessage({ mine: false }), { isGroup: true, head: false });
    expect(hasAvatar(root)).toBe(false);
    expect(allText(root)).not.toContain('Alice');
  });
});

/** The in-bubble meta element's props (time, edited, status and placement). */
function metaOf(root: ReactElement): Parameters<typeof BubbleMetaView>[0] | null {
  let meta: Parameters<typeof BubbleMetaView>[0] | null = null;
  walk(root, (el) => {
    if (el.type === BubbleMetaView) meta = el.props as Parameters<typeof BubbleMetaView>[0];
    // A voice note draws the time inside its own last row.
    const voiceMeta = (el.props as { voice?: { meta?: ReactNode } }).voice?.meta;
    if (isValidElement(voiceMeta) && voiceMeta.type === BubbleMetaView) {
      meta = voiceMeta.props as Parameters<typeof BubbleMetaView>[0];
    }
  });
  return meta;
}

/** The failed send's Retry: the 44px alert beside the bubble. */
function isRetry(el: ReactElement): boolean {
  return (el.props as Record<string, unknown>)['aria-label'] === 'Retry sending';
}

/** The line under a failed bubble, rendered to markup. */
function failedLine(root: ReactElement): string {
  const html = renderStrip(root);
  const match = /data-failed="[^"]*"[^>]*>([^<]*)</.exec(html);
  return match?.[1] ?? '';
}

describe('MessageBubble time and state', () => {
  it('shows the time inside the bubble, h:mm am/pm on the workspace clock', () => {
    const message = makeMessage({});
    const root = renderBubble(message, { timeZone: 'Asia/Kolkata' });
    expect(metaOf(root)?.meta.time).toBe(T_KOLKATA);
    let aria = '';
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (props['data-bubble'] !== undefined) aria = String(props['aria-label']);
    });
    expect(aria).toContain(T_KOLKATA);
    expect(bubbleTimeLabel(message, 'UTC')).toBe(T_UTC);
    expect(renderStrip(root)).toContain(T_KOLKATA);
  });

  it('labels a sending bubble and a failed bubble instead of a time', () => {
    expect(bubbleTimeLabel(makeMessage({ state: 'sending', createdAt: '' }), 'UTC')).toBe(
      'Sending',
    );
    expect(bubbleTimeLabel(makeMessage({ state: 'failed', createdAt: '' }), 'UTC')).toBe(
      'Not sent',
    );
  });

  it('offers a 44px Retry control on an own failed bubble that resends the same id', () => {
    const onRetry = vi.fn();
    const root = renderBubble(
      makeMessage({ id: 'm-fail', mine: true, state: 'failed', createdAt: '' }),
      {
        onRetry,
      },
    );
    let retry: ReactElement | null = null;
    walk(root, (el) => {
      if (isRetry(el)) retry = el;
    });
    expect(retry).not.toBeNull();
    (
      retry as unknown as { props: { onClick: (e: { stopPropagation: () => void }) => void } }
    ).props.onClick({ stopPropagation: () => {} });
    expect(onRetry).toHaveBeenCalledWith('m-fail');
    expect((root.props as { 'data-state': string })['data-state']).toBe('failed');
  });

  it('a send whose files were lost to a reload reads "Photos not sent" with Remove only', () => {
    const onRetry = vi.fn();
    const message = makeMessage({
      id: 'm-lost',
      mine: true,
      state: 'failed',
      createdAt: '',
      filesMissing: true,
    });
    expect(bubbleTimeLabel(message, 'UTC')).toBe('Photos not sent');
    expect(bubbleStatus(message, { showTicks: true })).toBe('files-missing');
    const root = renderBubble(message, { onRetry });
    const labels: string[] = [];
    let remove: ReactElement | null = null;
    walk(root, (el) => {
      const label = (el.props as { label?: string }).label;
      if (label !== undefined) labels.push(label);
      if (label === 'Remove message') remove = el;
    });
    expect(labels).not.toContain('Retry sending');
    let retry = false;
    walk(root, (el) => {
      if (isRetry(el)) retry = true;
    });
    expect(retry).toBe(false);
    expect(remove).not.toBeNull();
    expect(failedLine(root)).toBe('Photos not sent');
    (remove as unknown as { props: { onClick: () => void } }).props.onClick();
    expect(onRetry).toHaveBeenCalledWith('m-lost');
  });

  it('has no Retry control on a sent bubble or a peer bubble', () => {
    for (const message of [
      makeMessage({ mine: true }),
      makeMessage({ state: 'failed', mine: false }),
    ]) {
      let retry: ReactElement | null = null;
      walk(renderBubble(message, { onRetry: vi.fn() }), (el) => {
        if (isRetry(el)) retry = el;
      });
      expect(retry).toBeNull();
    }
  });
});

describe('bubble shell', () => {
  const base = { head: false, failed: false, voiceOnly: false, layout: 'touch' as const };

  it('own is the bubble-own fill with accent-fg ink, peer is panel-2; no border', () => {
    const own = bubbleClass({ ...base, mine: true, tail: true });
    const peer = bubbleClass({ ...base, mine: false, tail: true });
    expect(own).toContain('bg-bubble-own text-accent-fg');
    expect(own.split(' ')).not.toContain('bg-accent');
    expect(peer).toContain('bg-panel-2 text-fg');
    for (const cls of [own, peer]) {
      expect(cls).toContain('rounded-[18px]');
      expect(cls.split(' ')).not.toContain('border');
    }
  });

  it('squares the sender-side corner only on the tail', () => {
    expect(bubbleClass({ ...base, mine: true, tail: true })).toContain('rounded-br-[4px]');
    expect(bubbleClass({ ...base, mine: false, tail: true })).toContain('rounded-bl-[4px]');
    expect(bubbleClass({ ...base, mine: true, tail: false })).not.toContain('rounded-br-[4px]');
    expect(bubbleClass({ ...base, mine: false, tail: false })).not.toContain('rounded-bl-[4px]');
  });

  it('F6 laptop: the first bubble of a run keeps its tail corner, later ones are fully 7.5px', () => {
    const laptop = { ...base, layout: 'laptop' as const };
    for (const mine of [true, false]) {
      const corner = mine ? 'rounded-tr-none' : 'rounded-tl-none';
      const first = bubbleClass({ ...laptop, mine, head: true, tail: false }).split(' ');
      const later = bubbleClass({ ...laptop, mine, head: false, tail: true }).split(' ');
      expect(first).toEqual(expect.arrayContaining(['rounded-[7.5px]', corner]));
      expect(later).toContain('rounded-[7.5px]');
      expect(later.filter((c) => c.startsWith('rounded-'))).toEqual(['rounded-[7.5px]']);
      expect(first).not.toContain('rounded-[18px]');
    }
    // Touch is unchanged: 18px, the 4px tail on the last bubble, nothing on the head.
    const touchHead = bubbleClass({ ...base, mine: true, head: true, tail: false }).split(' ');
    expect(touchHead.filter((c) => c.startsWith('rounded-'))).toEqual(['rounded-[18px]']);
  });

  it('caps rows at 76% and spaces rows 2px in a run, 10px between runs', () => {
    const headRow = renderBubble(makeMessage({}), { head: true });
    const tucked = renderBubble(makeMessage({}), { head: false });
    expect(rootClass(headRow)).toContain('pt-2.5');
    expect(rootClass(tucked)).toContain('pt-0.5');
    expect(rootClass(headRow)).not.toContain('py-2');
    let column = '';
    walk(headRow, (el) => {
      const cls = (el.props as { className?: string }).className ?? '';
      if (cls.includes('max-w-')) column = cls;
    });
    expect(column).toContain('max-w-[76%]');
  });
});

describe('in-bubble meta and ticks', () => {
  const own = (over: Partial<ThreadMessage>) => makeMessage({ mine: true, ...over });

  it('ticks every own DM bubble (not only the run tail); none on peers or groups', () => {
    expect(bubbleStatus(own({ status: 'sent' }), { showTicks: true })).toBe('delivered');
    expect(bubbleStatus(own({ status: 'read' }), { showTicks: true })).toBe('read');
    expect(bubbleStatus(own({}), { showTicks: false })).toBeNull();
    expect(bubbleStatus(makeMessage({}), { showTicks: true })).toBeNull();
    const nonTail = renderBubble(own({ status: 'read' }), { showTicks: true, tail: false });
    expect(metaOf(nonTail)?.meta.status).toBe('read');
  });

  it('delivered is a single tick in the meta ink; read a double tick in the read token', () => {
    const delivered = renderStrip(renderBubble(own({ status: 'sent' }), { showTicks: true }));
    expect(delivered).toContain('data-tick="delivered"');
    expect(delivered).toContain('aria-label="Delivered"');
    expect(delivered).toContain('text-[color:var(--bubble-meta-own)]');
    const read = renderStrip(renderBubble(own({ status: 'read' }), { showTicks: true }));
    expect(read).toMatch(
      /data-tick="read"[^>]*text-\[color:var\(--tick-read\)\]|text-\[color:var\(--tick-read\)\][^>]*data-tick="read"/,
    );
    // The tick box is 16x11.
    expect(read).toMatch(/viewBox="0 0 16 11"/);
    expect(read).toContain('h-[11px] w-4');
  });

  it('peer meta takes the peer meta token; no tick', () => {
    const html = renderStrip(renderBubble(makeMessage({}), { showTicks: true }));
    expect(html).toContain('text-[color:var(--bubble-meta)]');
    expect(html).not.toContain('data-tick');
  });

  it('F4 sending: a clock in the meta ink at full strength; no opacity anywhere', () => {
    const root = renderBubble(own({ state: 'sending' }), { showTicks: true });
    expect(metaOf(root)?.meta.status).toBe('sending');
    const html = renderStrip(root);
    expect(html).toContain('data-tick="sending"');
    expect(html).toContain('text-[color:var(--bubble-meta-own)]');
    let bubble = '';
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (props['data-bubble'] !== undefined) bubble = String(props.className);
    });
    expect(bubble).not.toContain('opacity');
    expect(html).toMatch(/data-meta="inline" data-status="sending" class="(?![^"]*opacity)[^"]*"/);
  });

  it('F4 failed: a red "!" outside the bubble (44x44, left, centred) that retries; no in-bubble glyph', () => {
    const onRetry = vi.fn();
    const root = renderBubble(own({ id: 'm-f', state: 'failed' }), { showTicks: true, onRetry });
    const html = renderStrip(root);
    expect(html).not.toContain('data-tick=');
    expect(failedLine(root)).toBe('Not sent');
    let retry: ReactElement<Record<string, unknown>> | null = null;
    walk(root, (el) => {
      if ((el.props as Record<string, unknown>)['data-failed-retry'] !== undefined) {
        retry = el as ReactElement<Record<string, unknown>>;
      }
    });
    expect(retry).not.toBeNull();
    const button = retry as unknown as ReactElement<Record<string, unknown>>;
    expect(button.props['aria-label']).toBe('Retry sending');
    const cls = String(button.props.className).split(' ');
    expect(cls).toEqual(
      expect.arrayContaining([
        'absolute',
        'right-full',
        'top-1/2',
        '-translate-y-1/2',
        'h-11',
        'w-11',
        'text-bad',
      ]),
    );
    expect(FAILED_RETRY_CLASS).not.toContain('bg-bad ');
    expect(renderStrip(button as ReactElement)).toContain('data-failed-glyph');
    (button.props.onClick as (e: { stopPropagation: () => void }) => void)({
      stopPropagation: () => {},
    });
    expect(onRetry).toHaveBeenCalledWith('m-f');
  });

  it('F13: the retry keeps button semantics; the status text is its own role="status" element', () => {
    const root = renderBubble(own({ id: 'm-f', state: 'failed' }), {
      showTicks: true,
      onRetry: vi.fn(),
    });
    let retry: ReactElement<Record<string, unknown>> | null = null;
    walk(root, (el) => {
      if ((el.props as Record<string, unknown>)['data-failed-retry'] !== undefined) {
        retry = el as ReactElement<Record<string, unknown>>;
      }
    });
    const button = retry as unknown as ReactElement<Record<string, unknown>>;
    expect(button.type).toBe('button');
    expect(button.props.role).toBeUndefined();
    expect(renderStrip(button as ReactElement)).not.toContain('role="status"');
    const html = renderStrip(root);
    expect(html).toMatch(/<span role="status" data-failed="failed"[^>]*>Not sent<\/span>/);
    expect(renderStrip(<FailedLine status="files-missing" />)).toContain('role="status"');
  });

  it('text bubbles end with an invisible spacer the width of the meta', () => {
    const root = renderBubble(makeMessage({ editedAt: '2026-09-22T18:50:00Z' }));
    expect(metaOf(root)?.placement).toBe('inline');
    let spacer: ReactElement | null = null;
    walk(root, (el) => {
      if (el.type === MetaSpacer) spacer = el;
    });
    expect(spacer).not.toBeNull();
    const html = renderStrip(spacer as unknown as ReactElement);
    expect(html).toContain('invisible');
    expect(html).toContain('aria-hidden="true"');
    // Same parts as the meta, so the same width.
    expect(html).toContain('edited');
    expect(html).toContain(T_UTC);
    let bodySpacer = false;
    walk(root, (el) => {
      const props = el.props as { className?: string; children?: ReactNode };
      if (props.className !== bodyText('touch')) return;
      walk(props.children, (child) => {
        if (child.type === MetaSpacer) bodySpacer = true;
      });
    });
    expect(bodySpacer).toBe(true);
  });

  it('F3: only a bare image album gets the pill; everything else a row below the content', () => {
    const image = makeMessage({
      body: '',
      attachments: [{ assetId: 'i1', name: 'a.png', mime: 'image/png' }],
    });
    const voice = makeMessage({
      body: '',
      attachments: [{ assetId: 'v1', name: 'n.webm', mime: 'audio/webm', durationMs: 1000 }],
    });
    const file = makeMessage({
      body: '',
      attachments: [{ assetId: 'f1', name: 'a.pdf', mime: 'application/pdf' }],
    });
    const video = makeMessage({
      body: '',
      attachments: [{ assetId: 'm1', name: 'a.mp4', mime: 'video/mp4' }],
    });
    const card = makeMessage({ body: '', sharedPostIds: ['p1'] });
    const brief = makeMessage({ body: '', sharedBriefIds: ['b1'] });
    const expected: Array<[ThreadMessage, string]> = [
      [image, 'pill'],
      [{ ...image, body: 'look' }, 'row'],
      [voice, 'row'],
      [file, 'row'],
      [video, 'row'],
      [card, 'row'],
      [brief, 'row'],
      [makeMessage({ body: 'hi' }), 'inline'],
    ];
    for (const [message, placement] of expected) {
      expect(metaPlacement(message)).toBe(placement);
      const root = renderBubble(message);
      expect(metaOf(root)?.placement).toBe(placement);
      let spacers = 0;
      walk(root, (el) => {
        if (el.type === MetaSpacer) spacers += 1;
      });
      expect(spacers).toBe(placement === 'inline' ? 1 : 0);
    }
    // The row is in flow (never absolute), right-aligned, after the content.
    const row = renderStrip(
      BubbleMetaView({
        meta: bubbleMeta(voice, 'UTC', { showTicks: false }),
        mine: false,
        placement: 'row',
      }),
    );
    expect(row).toMatch(/data-meta="row"[^>]*class="[^"]*flex justify-end/);
    expect(row).not.toContain('absolute');
    const voiceHtml = renderStrip(renderBubble(voice));
    expect(voiceHtml.indexOf('data-meta="row"')).toBeGreaterThan(
      voiceHtml.indexOf('data-bubble-content'),
    );
    const pill = renderStrip(
      BubbleMetaView({
        meta: bubbleMeta(image, 'UTC', { showTicks: false }),
        mine: false,
        placement: 'pill',
      }),
    );
    expect(pill).toContain('bg-[color:var(--media-meta-bg)]');
    expect(pill).toContain('text-[color:var(--media-meta-fg)]');
    // Media with a caption, or with cards or other files, takes the row.
    expect(metaPlacement({ ...image, body: 'look', sharedPostIds: ['p'] })).toBe('row');
    expect(
      metaPlacement({ ...image, attachments: [...image.attachments, ...file.attachments] }),
    ).toBe('row');
  });
});

describe('threadRows', () => {
  const t = (iso: string) => ({ createdAt: iso, time: Date.parse(iso) });
  const msgs = [
    makeMessage({ id: 'a', mine: true, senderUserId: 'me', ...t('2026-09-21T10:00:00Z') }),
    makeMessage({ id: 'b', mine: true, senderUserId: 'me', ...t('2026-09-21T10:05:00Z') }),
    makeMessage({ id: 'c', mine: true, senderUserId: 'me', ...t('2026-09-21T10:15:00Z') }),
    makeMessage({ id: 'd', ...t('2026-09-21T10:16:00Z') }),
    makeMessage({ id: 'e', ...t('2026-09-22T09:00:00Z') }),
  ];
  const rows = threadRows(msgs, Date.parse('2026-09-22T12:00:00Z'), 'UTC');
  const msg = (id: string) =>
    rows.find(
      (r): r is Extract<ThreadRow, { kind: 'message' }> =>
        r.kind === 'message' && r.message.id === id,
    );

  it('computes runs: head on the first, tail on the last', () => {
    expect([msg('a')?.head, msg('a')?.tail]).toEqual([true, false]);
    expect([msg('b')?.head, msg('b')?.tail]).toEqual([false, true]);
    // A 10-minute gap breaks the run even from the same sender.
    expect([msg('c')?.head, msg('c')?.tail]).toEqual([true, true]);
    expect([msg('d')?.head, msg('d')?.tail]).toEqual([true, true]);
    // A day pill breaks the run.
    expect([msg('e')?.head, msg('e')?.tail]).toEqual([true, true]);
  });

  it('has day pills and message rows only: no per-run time rows', () => {
    expect(rows.map((r) => (r.kind === 'message' ? r.message.id : `${r.kind}:${r.label}`))).toEqual(
      ['day:Yesterday', 'a', 'b', 'c', 'd', 'day:Today', 'e'],
    );
    expect(rows.every((r) => r.kind === 'day' || r.kind === 'message')).toBe(true);
  });

  it('every message row carries its meta { time, edited, status }', () => {
    const withTicks = threadRows(msgs, Date.parse('2026-09-22T12:00:00Z'), 'UTC', {
      showTicks: true,
    });
    for (const row of withTicks) {
      if (row.kind !== 'message') continue;
      expect(row.meta).toEqual({
        time: formatClockTime(row.message.createdAt, 'UTC'),
        edited: false,
        status: row.message.mine ? 'delivered' : null,
      });
    }
  });

  it('meta times read the workspace clock', () => {
    const kolkata = threadRows(
      msgs.slice(0, 1),
      Date.parse('2026-09-22T12:00:00Z'),
      'Asia/Kolkata',
    );
    expect(kolkata.find((r) => r.kind === 'message')).toMatchObject({
      meta: { time: formatClockTime(msgs[0]?.createdAt ?? '', 'Asia/Kolkata') },
    });
  });
});

function findByChildren(root: ReactElement, text: string): ReactElement | null {
  let found: ReactElement | null = null;
  walk(root, (el) => {
    const child = (el.props as { children?: ReactNode }).children;
    if (child === text) found = el;
  });
  return found;
}

function findByAriaLabel(root: ReactElement, label: string): ReactElement | null {
  let found: ReactElement | null = null;
  walk(root, (el) => {
    if ((el.props as { ['aria-label']?: string })['aria-label'] === label) found = el;
  });
  return found;
}

describe('MessageBubble reply quote', () => {
  const preview = 'x'.repeat(300);
  const replyMessage = makeMessage({
    reply: { id: 'orig-7', authorUserId: 'peer-1', preview },
  });

  it('line-clamps the quote instead of truncating, and is a jump button', () => {
    const root = renderBubble(replyMessage);

    const previewSpan = findByChildren(root, preview);
    expect(previewSpan).not.toBeNull();
    const previewClass = (previewSpan?.props as { className?: string }).className ?? '';
    expect(previewClass).toContain('line-clamp-2');
    expect(previewClass).toContain('[overflow-wrap:anywhere]');
    expect(previewClass).not.toContain('truncate');

    const authorSpan = findByChildren(root, 'Alice');
    expect(authorSpan).not.toBeNull();
    const authorClass = (authorSpan?.props as { className?: string }).className ?? '';
    expect(authorClass).toContain('line-clamp-1');

    const jump = findByAriaLabel(root, 'Go to quoted message');
    expect(jump).not.toBeNull();
    expect((jump?.props as { type?: string }).type).toBe('button');
  });

  it('invokes onJumpToMessage with the quoted id on click', () => {
    const onJumpToMessage = vi.fn();
    const root = MessageBubble({
      message: replyMessage,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: false,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: () => {},
      onJumpToMessage,
    });

    const jump = findByAriaLabel(root, 'Go to quoted message');
    expect(jump).not.toBeNull();
    const onClick = (jump?.props as { onClick?: (e: { stopPropagation: () => void }) => void })
      .onClick;
    onClick?.({ stopPropagation: () => {} });
    expect(onJumpToMessage).toHaveBeenCalledTimes(1);
    expect(onJumpToMessage).toHaveBeenCalledWith('orig-7');
  });
});

describe('MessageBubble forwarded label', () => {
  it('shows a small Forwarded label on incoming and own forwarded messages', () => {
    for (const mine of [false, true]) {
      let count = 0;
      walk(renderBubble(makeMessage({ mine, forwarded: true })), (el) => {
        if (el.type === ForwardedLabel) count += 1;
      });
      expect(count).toBe(1);
    }
    const label = ForwardedLabel();
    const cls = (label.props as { className: string }).className;
    expect(cls).toContain('text-fg-2');
    expect(cls).toContain('text-xs');
    expect((label.props as { children: unknown[] }).children).toContain('Forwarded');
    // On the solid accent the label takes the bubble's on-accent ink.
    const own = ForwardedLabel({ mine: true });
    expect((own.props as { className: string }).className).toContain('text-accent-fg');
  });

  it('has no label on a message that was not forwarded', () => {
    let count = 0;
    walk(renderBubble(makeMessage({})), (el) => {
      if (el.type === ForwardedLabel) count += 1;
    });
    expect(count).toBe(0);
  });
});

describe('MessageBubble keyboard and hover actions', () => {
  const noop = (): void => {};
  function pressed(
    over: {
      onKeyOpen?: () => void;
      onMore?: () => void;
      onReact?: () => void;
      onContextMenu?: (e: unknown) => void;
    } = {},
  ) {
    return {
      handlers: {
        onPointerDown: noop,
        onPointerMove: noop,
        onPointerUp: noop,
        onPointerCancel: noop,
      },
      onContextMenu: over.onContextMenu ?? noop,
      consumeClick: () => false,
      onKeyOpen: over.onKeyOpen ?? noop,
      ...(over.onMore !== undefined ? { onMore: over.onMore } : {}),
      ...(over.onReact !== undefined ? { onReact: over.onReact } : {}),
    };
  }
  function bubbleOf(root: ReactElement): ReactElement<Record<string, unknown>> {
    let found: ReactElement<Record<string, unknown>> | undefined;
    walk(root, (el) => {
      if ((el.props as Record<string, unknown>)['data-bubble'] !== undefined) {
        found = el as ReactElement<Record<string, unknown>>;
      }
    });
    if (found === undefined) throw new Error('no bubble');
    return found;
  }
  function render(press: ReturnType<typeof pressed>, message = makeMessage({})): ReactElement {
    return MessageBubble({
      message,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: false,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: noop,
      press,
    });
  }

  it('the bubble is a focusable group with a label', () => {
    const bubble = bubbleOf(render(pressed()));
    expect(bubble.props.role).toBe('group');
    expect(bubble.props.tabIndex).toBe(0);
    expect(bubble.props['aria-label']).toBe(`Message from Alice, ${T_UTC}`);
  });

  it('Enter, Space and Shift+F10 on the bubble open the menu; other keys do not', () => {
    const onKeyOpen = vi.fn();
    const bubble = bubbleOf(render(pressed({ onKeyOpen })));
    const onKeyDown = bubble.props.onKeyDown as (e: unknown) => void;
    const self = {};
    const key = (k: string, shiftKey = false, target: unknown = self) => ({
      key: k,
      shiftKey,
      target,
      currentTarget: self,
      preventDefault: vi.fn(),
    });
    onKeyDown(key('Enter'));
    onKeyDown(key(' '));
    onKeyDown(key('F10', true));
    expect(onKeyOpen).toHaveBeenCalledTimes(3);
    onKeyDown(key('a'));
    // Enter on a control inside the bubble (quoted reply) is that control's own.
    onKeyDown(key('Enter', false, {}));
    expect(onKeyOpen).toHaveBeenCalledTimes(3);
  });

  it('keyOpensMenu covers the ContextMenu key and ignores bubbling Enter', () => {
    const t = {};
    expect(
      keyOpensMenu({ key: 'ContextMenu', shiftKey: false, target: {}, currentTarget: t }),
    ).toBe(true);
    expect(keyOpensMenu({ key: 'Enter', shiftKey: false, target: {}, currentTarget: t })).toBe(
      false,
    );
  });

  it('Escape closes the menu, and the first action row gets focus on open', () => {
    expect(menuClosesOnKey('Escape')).toBe(true);
    expect(menuClosesOnKey('Enter')).toBe(false);
    const focus = vi.fn();
    const querySelector = vi.fn(() => ({ focus }));
    expect(focusFirstMenuItem({ querySelector })).toBe(true);
    expect(querySelector).toHaveBeenCalledWith('[data-menu-item]');
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusFirstMenuItem(null)).toBe(false);
  });

  const withAttr = (root: ReactElement, attr: string): ReactElement<Record<string, unknown>>[] => {
    const out: ReactElement<Record<string, unknown>>[] = [];
    walk(root, (el) => {
      if ((el.props as Record<string, unknown>)[attr] !== undefined) {
        out.push(el as ReactElement<Record<string, unknown>>);
      }
    });
    return out;
  };

  it('fine pointer: a 44x44 "Message options" chevron inside the bubble, top-right', () => {
    const onMore = vi.fn();
    expect(withAttr(render(pressed()), 'data-more')).toHaveLength(0);
    const root = render(pressed({ onMore }));
    const [button] = withAttr(root, 'data-more');
    const bubble = bubbleOf(root);
    // It sits inside the bubble.
    expect(withAttr(bubble, 'data-more')).toHaveLength(1);
    const cls = String(button?.props.className);
    expect(button?.props['aria-label']).toBe('Message options');
    expect(cls).toContain('h-11 w-11');
    expect(cls).toContain('absolute right-0 top-0');
    expect(cls).toContain('group-hover/bubble:opacity-100');
    expect(cls).toContain('focus-visible:opacity-100');
    // Opacity only, 120ms, none under reduced motion.
    expect(cls).toContain('transition-opacity duration-[120ms] motion-reduce:transition-none');
    const [glyph] = withAttr(root, 'data-more-glyph');
    expect(String(glyph?.props.className)).toContain('bg-gradient-to-l');
    const stop = vi.fn();
    (button?.props.onClick as (e: unknown) => void)({ stopPropagation: stop });
    expect(onMore).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
  });

  it('the chevron gradient takes the bubble colour: own fill or peer panel', () => {
    const own = withAttr(
      render(pressed({ onMore: noop }), makeMessage({ mine: true })),
      'data-more-glyph',
    );
    expect(String(own[0]?.props.className)).toContain('from-bubble-own');
    const peer = withAttr(render(pressed({ onMore: noop })), 'data-more-glyph');
    expect(String(peer[0]?.props.className)).toContain('from-panel-2');
  });

  it('right-click on the bubble goes to the same menu opener as long-press', () => {
    const onContextMenu = vi.fn();
    const bubble = bubbleOf(render(pressed({ onContextMenu })));
    expect(bubble.props.onContextMenu).toBe(onContextMenu);
  });

  it('fine pointer: a 44x44 smiley beside the bubble opens the reactions row', () => {
    const onReact = vi.fn();
    expect(withAttr(render(pressed()), 'data-react')).toHaveLength(0);
    const root = render(pressed({ onReact }));
    const [button] = withAttr(root, 'data-react');
    expect(withAttr(bubbleOf(root), 'data-react')).toHaveLength(0);
    expect(String(button?.props.className)).toContain('h-11 w-11');
    (button?.props.onClick as () => void)();
    expect(onReact).toHaveBeenCalledTimes(1);
    // Not on an unrecorded message.
    const sending = render(pressed({ onReact }), makeMessage({ mine: true, state: 'sending' }));
    expect(withAttr(sending, 'data-react')).toHaveLength(0);
  });
});

describe('voice-only bubble', () => {
  const voice = makeMessage({
    body: '',
    attachments: [{ assetId: 'v1', name: 'note.webm', mime: 'audio/webm', durationMs: 18_000 }],
  });

  it('is detected only for a lone audio attachment with no text or cards', () => {
    expect(isVoiceOnly(voice)).toBe(true);
    expect(isVoiceOnly({ ...voice, body: 'hi' })).toBe(false);
    expect(isVoiceOnly({ ...voice, sharedPostIds: ['p'] })).toBe(false);
    expect(
      isVoiceOnly({
        ...voice,
        attachments: [{ assetId: 'f', name: 'a.pdf', mime: 'application/pdf' }],
      }),
    ).toBe(false);
  });

  it('uses the text-bubble shell with its time in the row under the note', () => {
    const root = renderBubble(voice);
    let cls = '';
    walk(root, (el) => {
      const props = el.props as { className?: string } & Record<string, unknown>;
      if (props['data-bubble'] !== undefined) cls = props.className ?? '';
    });
    expect(cls).toContain('rounded-[18px]');
    expect(cls).toContain('min-w-[220px]');
    expect(metaOf(root)).toMatchObject({ placement: 'row', meta: { time: T_UTC } });
  });

  it('hands the voice note its message id, side, sender and the next voice id', () => {
    const root = renderBubble(voice);
    let voiceProp: unknown;
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (props.voice !== undefined) voiceProp = props.voice;
    });
    expect(voiceProp).toMatchObject({ messageId: 'm1', mine: false, nextVoiceId: null });
  });

  const voiceContext = (root: ReactElement): Record<string, unknown> => {
    let found: Record<string, unknown> = {};
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (props.voice !== undefined) found = props.voice as Record<string, unknown>;
    });
    return found;
  };

  it('draws the time inside the note, never as a trailing row after it', () => {
    const root = renderBubble(voice);
    let trailing = 0;
    walk(root, (el) => {
      if (el.type === BubbleMetaView) trailing += 1;
    });
    expect(trailing).toBe(0);
    expect(isValidElement(voiceContext(root).meta)).toBe(true);
  });

  it('hands the Transcribe flow to received recorded notes only', () => {
    const onTranscribe = vi.fn();
    const received = voiceContext(renderBubble(voice, { onTranscribe }));
    expect(received.onTranscribe).toBe(onTranscribe);
    const own = voiceContext(renderBubble({ ...voice, mine: true }, { onTranscribe }));
    expect(own.onTranscribe).toBeUndefined();
    const sending = voiceContext(renderBubble({ ...voice, state: 'sending' }, { onTranscribe }));
    expect(sending.onTranscribe).toBeUndefined();
    expect(voiceContext(renderBubble(voice)).onTranscribe).toBeUndefined();
  });
});

describe('voice notes: auto-play chain and Transcribe', () => {
  const note = (id: string, sender: string, over: Partial<ThreadMessage> = {}): ThreadMessage =>
    makeMessage({
      id,
      senderUserId: sender,
      body: '',
      attachments: [{ assetId: `a-${id}`, name: 'n.webm', mime: 'audio/webm' }],
      ...over,
    });

  it('links a voice note to the voice note directly below from the same sender only', () => {
    const next = nextVoiceIds([
      note('v1', 'peer-1'),
      note('v2', 'peer-1'),
      note('v3', 'peer-2'),
      makeMessage({ id: 't1', senderUserId: 'peer-2' }),
      note('v4', 'peer-2'),
      note('v5', 'peer-2', { deleted: true }),
    ]);
    expect([...next.entries()]).toEqual([['v1', 'v2']]);
  });

  it('never links across a text message, and one pass over the list', () => {
    const next = nextVoiceIds([
      note('v1', 'peer-1'),
      makeMessage({ id: 't', senderUserId: 'peer-1' }),
      note('v2', 'peer-1'),
    ]);
    expect(next.size).toBe(0);
  });

  it('offers Transcribe only for a recorded message whose single attachment is audio', () => {
    expect(isTranscribable(note('v1', 'peer-1'))).toBe(true);
    expect(isTranscribable(note('v1', 'peer-1', { state: 'sending' }))).toBe(false);
    expect(isTranscribable(note('v1', 'peer-1', { deleted: true }))).toBe(false);
    expect(
      isTranscribable(
        note('v1', 'peer-1', {
          attachments: [
            { assetId: 'a', name: 'n.webm', mime: 'audio/webm' },
            { assetId: 'b', name: 'n2.webm', mime: 'audio/webm' },
          ],
        }),
      ),
    ).toBe(false);
    expect(
      isTranscribable(
        note('v1', 'peer-1', {
          attachments: [{ assetId: 'f', name: 'a.pdf', mime: 'application/pdf' }],
        }),
      ),
    ).toBe(false);
  });
});

describe('bottom pin', () => {
  const rows = threadRows(
    [makeMessage({ id: 'first' }), makeMessage({ id: 'second' })],
    Date.parse('2026-09-22T20:00:00Z'),
    'UTC',
  );
  const render = (row: Extract<ThreadRow, { kind: 'message' }>) => (
    <li key={row.message.id} data-msg-id={row.message.id} />
  );

  it('the list is a flex column, never justify-end on the scroll container', () => {
    expect(THREAD_LIST_CLASS.split(' ')).toEqual(
      expect.arrayContaining(['flex', 'flex-col', 'flex-1', 'overflow-y-auto']),
    );
    expect(THREAD_LIST_CLASS).not.toContain('justify-end');
  });

  it('renders the aria-hidden mt-auto spacer first, then the first message', () => {
    const items = threadListItems(rows, false, render);
    const spacer = items[0]?.props as Record<string, unknown>;
    expect(spacer['aria-hidden']).toBe('true');
    expect(spacer.className).toBe('mt-auto');
    const firstMessage = items.find(
      (el) => (el.props as Record<string, unknown>)['data-msg-id'] !== undefined,
    );
    expect((firstMessage?.props as Record<string, unknown>)['data-msg-id']).toBe('first');
    expect(items.indexOf(firstMessage as never)).toBeGreaterThan(0);
  });

  it('keeps the spacer ahead of the older-page row', () => {
    const items = threadListItems(rows, true, render);
    expect((items[0]?.props as Record<string, unknown>)['data-thread-spacer']).toBe('');
    expect(allText(items[1] as ReactElement)).toContain('Loading earlier messages');
  });
});

describe('dmHeaderLine', () => {
  const base = {
    isGroup: false,
    peerTyping: false,
    role: 'client',
    workspaceName: 'Northwind',
  };
  const roleLine = `${roleLabel(base.role)} · ${base.workspaceName}`;

  it('rests on "<role label> · <workspace>" whatever the peer presence (offline included)', () => {
    expect(dmHeaderLine(base)).toBe(roleLine);
  });

  it('typing replaces the role line, then the role line returns', () => {
    expect(dmHeaderLine({ ...base, peerTyping: true })).toBe(HEADER_TYPING);
    expect(dmHeaderLine(base)).toBe(roleLine);
  });

  it('never carries presence or last-seen text in any state', () => {
    const presenceCopy = /last seen|offline|online/i;
    for (const isGroup of [false, true]) {
      for (const peerTyping of [false, true]) {
        for (const role of ['client', null]) {
          for (const workspaceName of ['Northwind', undefined]) {
            const line = dmHeaderLine({ isGroup, peerTyping, role, workspaceName });
            expect(line ?? '').not.toMatch(presenceCopy);
          }
        }
      }
    }
    expect(dmHeaderLine({ ...base, role: null, workspaceName: undefined })).toBeNull();
  });

  it('shows the workspace name alone when the role is null', () => {
    expect(dmHeaderLine({ ...base, role: null })).toBe(base.workspaceName);
  });

  it('groups keep no second line', () => {
    expect(dmHeaderLine({ ...base, isGroup: true, peerTyping: true })).toBeNull();
  });
});

describe('label spacing', () => {
  it('a head directly under a day pill gets no top padding', () => {
    const flush = rootClass(renderBubble(makeMessage({}), { head: true, afterLabel: true }));
    expect(flush).toContain('pt-0');
    expect(flush).not.toContain('pt-2.5');
    // Between runs with no label the gap stays 10px.
    expect(rootClass(renderBubble(makeMessage({}), { head: true }))).toContain('pt-2.5');
  });

  it('the day pill carries the 6px gap below it', () => {
    let pill = '';
    walk(DayPill({ label: 'Today', layout: 'touch' }), (el) => {
      const cls = (el.props as { className?: string }).className ?? '';
      if (cls.includes('rounded-full')) pill = cls;
    });
    expect(pill).toContain('mb-1.5');
  });

  it('threadListItems flags the message after a day pill only', () => {
    const t = (iso: string) => ({ createdAt: iso, time: Date.parse(iso) });
    const rows = threadRows(
      [
        makeMessage({ id: 'a', ...t('2026-09-22T10:00:00Z') }),
        makeMessage({ id: 'b', ...t('2026-09-22T10:01:00Z') }),
        makeMessage({ id: 'c', mine: true, senderUserId: 'me', ...t('2026-09-22T10:02:00Z') }),
      ],
      Date.parse('2026-09-22T12:00:00Z'),
      'UTC',
    );
    const flags: Record<string, boolean> = {};
    threadListItems(rows, false, (row, afterLabel) => {
      flags[row.message.id] = afterLabel;
      return <li key={row.message.id} />;
    });
    expect(flags).toEqual({ a: true, b: false, c: false });
  });
});

describe('own-bubble inner content', () => {
  function contentClass(root: ReactElement): string | null {
    let cls: string | null = null;
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (props['data-bubble-content'] !== undefined) cls = String(props.className);
    });
    return cls;
  }

  it('own bubbles restyle quote, chips, cards and voice onto the fill', () => {
    const cls = contentClass(renderBubble(makeMessage({ mine: true, senderUserId: 'me' })));
    expect(cls).toContain(OWN_BUBBLE_CONTENT);
    for (const token of [
      '[&_.text-fg]:text-accent-fg',
      '[&_.text-accent]:text-accent-fg',
      '[&_.text-fg-2]:text-accent-fg',
      '[&_.text-fg-2]:opacity-80',
      '[&_.text-fg-3]:opacity-80',
      '[&_.bg-panel]:bg-white/[.16]',
      '[&_.bg-panel-3]:bg-white/[.16]',
      '[&_.bg-accent]:bg-white/70',
    ]) {
      expect(OWN_BUBBLE_CONTENT).toContain(token);
    }
    // No theme-literal variants: token ink plus accent-fg's own value only.
    expect(OWN_BUBBLE_CONTENT).not.toContain(['dark', ':'].join(''));
  });

  it('peer bubbles are unchanged', () => {
    const cls = contentClass(renderBubble(makeMessage({ mine: false })));
    expect(cls).toBe('contents');
  });

  it('F5: the badge hangs under the bubble, over its bottom edge by 3px, clear of the meta and the next row', () => {
    const reactions = [{ emoji: '👍', count: 1, mine: false }];
    for (const message of [
      makeMessage({ body: 'ok', reactions }),
      makeMessage({ body: 'a much longer message body', mine: true, reactions }),
      makeMessage({
        body: '',
        attachments: [{ assetId: 'f1', name: 'a.pdf', mime: 'application/pdf' }],
        reactions,
      }),
    ]) {
      const root = renderBubble(message);
      let badge = '';
      let meta = '';
      walk(root, (el) => {
        const props = el.props as Record<string, unknown>;
        if (props['data-reaction-badge'] !== undefined) badge = String(props.className);
      });
      const view = metaOf(root);
      const html = view !== null ? renderStrip(BubbleMetaView(view)) : '';
      meta = /class="([^"]*)"/.exec(html)?.[1] ?? '';
      expect(badge).toBe(REACTION_BADGE_CLASS);
      // Top edge 3px above the bubble's bottom; nothing anchors it to the bottom.
      expect(badge.split(' ')).toContain('top-[calc(100%-3px)]');
      expect(badge).not.toMatch(/(^| )-?bottom-/);
      // The meta starts 3px or more above the bubble's bottom (or sits in flow above it).
      expect(meta).toMatch(/bottom-\[3px\]|bottom-2|mt-1 flex justify-end/);
      expect(rootClass(root).split(' ')).toContain(REACTION_ROW_SPACE);
    }
    // 20px of room below: the ~17px overhang never touches the next bubble.
    expect(REACTION_ROW_SPACE).toBe('mb-5');
  });

  it('the reaction count on an own bubble reads on its panel badge', () => {
    const reactions = [
      { emoji: '👍', count: 2, mine: false },
      { emoji: '🎉', count: 1, mine: false },
    ];
    const own = findByChildren(
      renderBubble(makeMessage({ mine: true, senderUserId: 'me', reactions })),
      3 as never,
    );
    expect((own?.props as { className?: string }).className).toContain('text-fg-2');
  });
});

describe('time source', () => {
  it('the in-bubble meta and the bubble aria-label read the same server createdAt', () => {
    // Agora time a few minutes off the server clock: the server time wins for both.
    const message = makeMessage({
      createdAt: '2026-09-22T18:45:00Z',
      time: Date.parse('2026-09-22T18:52:00Z'),
    });
    const rows = threadRows([message], Date.parse('2026-09-22T20:00:00Z'), 'UTC');
    const row = rows.find(
      (r): r is Extract<ThreadRow, { kind: 'message' }> => r.kind === 'message',
    );
    expect(row?.meta.time).toBe(T_UTC);
    const aria = (findByAriaLabel(renderBubble(message), `Message from Alice, ${T_UTC}`) ??
      null) as ReactElement | null;
    expect(aria).not.toBeNull();
    expect(bubbleTimeLabel(message, 'UTC')).toBe(row?.meta.time);
  });

  it('falls back to the Agora time only while createdAt is absent', () => {
    const time = Date.parse('2026-09-22T18:52:00Z');
    expect(messageTimeSource({ createdAt: '', time })).toBe(time);
    expect(messageTimeSource({ createdAt: CREATED_AT, time })).toBe(CREATED_AT);
  });
});

describe('image album and viewer', () => {
  const img = (n: number) => ({ assetId: `v-${n}`, name: `p${n}.png`, mime: 'image/png' });
  const pdf = { assetId: 'v-f', name: 'brief.pdf', mime: 'application/pdf' };
  const albumMessage = makeMessage({
    body: 'look',
    attachments: [img(1), pdf, img(2), img(3)],
  });

  function attachmentsEl(root: ReactElement): ReactElement | null {
    let found: ReactElement | null = null;
    walk(root, (el) => {
      if (el.type === MessageAttachments) found = el;
    });
    return found;
  }

  it('renders the album with its caption and 3px bubble padding', () => {
    expect(hasAlbum(albumMessage)).toBe(true);
    expect(hasAlbum(makeMessage({ attachments: [pdf] }))).toBe(false);
    const el = attachmentsEl(renderBubble(albumMessage));
    const props = el?.props as { album?: boolean; caption?: ReactElement };
    expect(props.album).toBe(true);
    expect(props.caption).toBeDefined();
    const cls = bubbleClass({
      mine: false,
      head: true,
      tail: true,
      layout: 'touch',
      failed: false,
      voiceOnly: false,
      album: true,
    });
    expect(cls).toContain('p-[3px]');
    expect(cls).toContain('min-w-[240px]');
    expect(cls).not.toContain('px-3');
  });

  it('a tile tap opens the viewer at the tapped index', () => {
    const onOpenImage = vi.fn();
    const root = MessageBubble({
      message: albumMessage,
      profiles: PROFILES,
      cache,
      presignEnabled: true,
      showTicks: false,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: () => {},
      onOpenImage,
    });
    const props = attachmentsEl(root)?.props as {
      onImageClick: (a: unknown, index: number) => void;
    };
    props.onImageClick(img(3), 2);
    expect(onOpenImage).toHaveBeenCalledWith(2);
  });

  it('the viewer gets the image list only, with sender and the clock time', () => {
    const { images, details } = threadLightbox(albumMessage, PROFILES, 'Asia/Kolkata');
    expect(images).toEqual([
      { assetId: 'v-1', name: 'p1.png' },
      { assetId: 'v-2', name: 'p2.png' },
      { assetId: 'v-3', name: 'p3.png' },
    ]);
    expect(details).toEqual({
      sender: 'Alice',
      time: formatClockTime(albumMessage.createdAt, 'Asia/Kolkata'),
    });
  });

  it('an own upload still in flight opens from its local preview', () => {
    const file = new File(['x'], 'p.png', { type: 'image/png' });
    const message = makeMessage({
      mine: true,
      attachments: [
        {
          assetId: '',
          name: 'p.png',
          mime: 'image/png',
          local: { key: 'local-1', file, previewUrl: 'blob:p', progress: 0.3 },
        },
      ],
    });
    const { images, details } = threadLightbox(message, PROFILES, 'UTC');
    expect(images).toEqual([{ assetId: '', name: 'p.png', src: 'blob:p' }]);
    expect(details.sender).toBe('You');
  });
});

describe('swipe to reply', () => {
  const noop = (): void => {};
  const handlers = {
    onPointerDown: vi.fn(),
    onPointerMove: vi.fn(),
    onPointerUp: vi.fn(),
    onPointerCancel: vi.fn(),
  };
  const press = { handlers, onContextMenu: noop, consumeClick: () => false, onKeyOpen: noop };
  const img = (n: number) => ({ assetId: `s-${n}`, name: `s${n}.png`, mime: 'image/png' });
  const KINDS: Record<string, Partial<ThreadMessage>> = {
    text: {},
    album: { body: '', attachments: [img(1), img(2)] },
    file: { body: '', attachments: [{ assetId: 'f', name: 'a.pdf', mime: 'application/pdf' }] },
    audio: { body: '', attachments: [{ assetId: 'v', name: 'v.webm', mime: 'audio/webm' }] },
    post: { body: '', sharedPostIds: ['p1'] },
    brief: { body: '', sharedBriefIds: ['b1'] },
    forwarded: { forwarded: true },
    reply: { reply: { id: 'm0', authorUserId: 'peer-1', preview: 'earlier' } },
  };

  function render(message: ThreadMessage, selecting = false): ReactElement {
    return MessageBubble({
      message,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: true,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: noop,
      press,
      swipe: {},
      ...(selecting ? { selection: { role: 'selectable', checked: false, onToggle: noop } } : {}),
    });
  }
  function find(root: ReactNode, key: string): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    walk(root, (el) => {
      if ((el.props as Record<string, unknown>)[key] !== undefined) {
        out.push(el as ReactElement<Record<string, unknown>>);
      }
    });
    return out;
  }

  for (const [kind, over] of Object.entries(KINDS)) {
    for (const mine of [false, true]) {
      it(`attaches on a ${mine ? 'own' : 'peer'} ${kind} bubble`, () => {
        const root = render(makeMessage({ ...over, mine }));
        const [bubble, ...rest] = find(root, 'onPointerDown');
        expect(rest).toHaveLength(0);
        expect(bubble?.props['data-bubble']).toBe('');
        expect(bubble?.props['data-swipe-reply']).toBe('');
        expect(bubble?.props.onPointerDown).toBe(handlers.onPointerDown);
        expect(bubble?.props.onPointerMove).toBe(handlers.onPointerMove);
        expect(String(bubble?.props.className)).toContain('touch-pan-y');
        let icons = 0;
        walk(root, (el) => {
          if (el.type === SwipeReplyIcon) icons += 1;
        });
        expect(icons).toBe(1);
      });
    }
  }

  it('only the bubble carries swipe handlers', () => {
    const root = render(makeMessage({ mine: true, status: 'read' }));
    // Only the bubble itself takes pointer handlers.
    expect(find(root, 'onPointerDown')).toHaveLength(1);
    expect(find(root, 'data-swipe-reply')).toHaveLength(1);
  });

  it('day pills are never swipeable', () => {
    for (const root of [DayPill({ label: 'Today', layout: 'touch' })]) {
      expect(find(root, 'onPointerDown')).toHaveLength(0);
      expect(find(root, 'data-swipe-reply')).toHaveLength(0);
    }
  });

  it('sending and failed bubbles are not swipeable (no reply to an unrecorded id)', () => {
    for (const state of ['sending', 'failed'] as const) {
      const root = render(makeMessage({ mine: true, state }));
      const [bubble] = find(root, 'data-bubble');
      expect(bubble?.props['data-swipe-reply']).toBeUndefined();
      expect(String(bubble?.props.className)).not.toContain('touch-pan-y');
    }
  });

  it('is off while selecting', () => {
    const root = render(makeMessage({}), true);
    const [bubble] = find(root, 'data-bubble');
    expect(bubble?.props['data-swipe-reply']).toBeUndefined();
    expect(String(bubble?.props.className)).not.toContain('touch-pan-y');
    let icons = 0;
    walk(root, (el) => {
      if (el.type === SwipeReplyIcon) icons += 1;
    });
    expect(icons).toBe(0);
  });

  it('the icon is a 32px token circle with a 1.7 stroke, accent only when armed', () => {
    const icon = SwipeReplyIcon({});
    const cls = String((icon.props as { className?: string }).className);
    expect(cls).toContain('h-8 w-8');
    expect(cls).toContain('bg-panel-3');
    expect(cls).toContain('data-[armed]:bg-accent data-[armed]:text-accent-fg');
    expect(cls).toContain('scale-0');
    expect(cls).toContain('opacity-0');
    // Per-frame scale and opacity: no class transition lagging the finger.
    expect(cls).not.toContain('transition');
    const [svg] = find(icon, 'strokeWidth');
    expect(svg?.props.strokeWidth).toBe(1.7);
    expect(svg?.props.stroke).toBe('currentColor');
  });
});

describe('bubble text sizes', () => {
  it('body text comes from chat-type: 17/22 touch, 14.2/19 laptop', () => {
    expect(bodyText('touch')).toContain(BUBBLE_BODY_TYPE.touch);
    expect(bodyText('laptop')).toContain(BUBBLE_BODY_TYPE.laptop);
    expect(BUBBLE_BODY_TYPE.touch).toContain('text-[17px] leading-[22px]');
    expect(BUBBLE_BODY_TYPE.laptop).toContain('text-[14.2px] leading-[19px]');
  });

  it('the in-bubble quote uses the chat-type quote sizes; the composer bar keeps its own', () => {
    for (const layout of ['touch', 'laptop'] as const) {
      const inBubble = renderStrip(ReplyQuoteBox({ author: 'A', preview: 'p', inBubble: layout }));
      expect(inBubble).toContain(sized(QUOTE_AUTHOR_TYPE, layout));
      expect(inBubble).toContain(sized(QUOTE_TEXT_TYPE, layout));
    }
    const bar = renderStrip(ReplyQuoteBox({ author: 'A', preview: 'p' }));
    expect(bar).not.toContain(QUOTE_TEXT_TYPE.touch);
  });

  it('F12 bubble shape by layout: touch 18px, 12/8 padding, 76%; laptop 7.5px, 6/7/8/9, 65%', () => {
    const shape = { mine: false, head: false, tail: false, failed: false, voiceOnly: false };
    const touch = bubbleClass({ ...shape, layout: 'touch' });
    expect(touch).toContain('px-3 py-2');
    expect(touch).toContain('rounded-[18px]');
    const laptop = bubbleClass({ ...shape, layout: 'laptop' });
    expect(laptop).toContain('rounded-[7.5px]');
    expect(laptop).toContain('pb-[8px] pl-[9px] pr-[7px] pt-[6px]');
    for (const cls of [touch, laptop]) expect(cls).not.toContain('md:');
    const columnOf = (layout: ChatLayout): string => {
      let column = '';
      walk(renderBubble(makeMessage({}), { layout }), (el) => {
        const c = (el.props as { className?: string }).className ?? '';
        if (c.includes('max-w-')) column = c;
      });
      return column;
    };
    expect(columnOf('touch')).toContain('max-w-[76%]');
    expect(columnOf('laptop')).toContain('max-w-[65%]');
    expect(renderStrip(renderBubble(makeMessage({}), { layout: 'laptop' }))).not.toContain('md:');
  });

  it('meta, day pill and typing row sizes come from chat-type', () => {
    expect(renderStrip(renderBubble(makeMessage({})))).toContain(BUBBLE_META_TYPE);
    expect(BUBBLE_META_TYPE).toContain('text-[11px] leading-[15px]');
    let pill = '';
    walk(DayPill({ label: 'Today', layout: 'touch' }), (el) => {
      const c = (el.props as { className?: string }).className ?? '';
      if (c.includes('rounded-full')) pill = c;
    });
    expect(pill).toContain(DATE_PILL_TYPE.touch);
    expect(pill).not.toContain('font-mono');
    expect(DATE_PILL_TYPE.touch).toContain('tabular-nums');
    expect(DATE_PILL_TYPE.laptop).toContain('uppercase');
  });
});

describe('header online dot', () => {
  it('draws the dot only while the peer is online and presence is known', () => {
    expect(headerAvatarPresence({ online: true, available: true })).toBe('online');
    expect(headerAvatarPresence({ online: false, available: true })).toBeUndefined();
    expect(headerAvatarPresence({ online: true, available: false })).toBeUndefined();
    expect(headerAvatarPresence(undefined)).toBeUndefined();
  });

  it('the dot is a 10px good circle with a 2px panel ring at the bottom-right', () => {
    const dots: string[] = [];
    walk(Avatar({ name: 'Alice', presence: 'online' }), (el) => {
      const props = el.props as Record<string, unknown>;
      if (props['data-presence'] === 'online') dots.push(String(props.className));
    });
    expect(dots).toHaveLength(1);
    for (const token of ['h-2.5', 'w-2.5', 'rounded-full', 'bg-good', 'ring-2', 'ring-panel']) {
      expect(dots[0]).toContain(token);
    }
    expect(dots[0]).toContain('bottom-0');
    expect(dots[0]).toContain('right-0');
    let none = 0;
    walk(Avatar({ name: 'Alice' }), (el) => {
      if ((el.props as Record<string, unknown>)['data-presence'] !== undefined) none += 1;
    });
    expect(none).toBe(0);
  });
});

describe('message body links', () => {
  const ORIGIN = 'https://app.example.test';
  const links = (nodes: ReactNode): ReactElement<Record<string, unknown>>[] => {
    const found: ReactElement<Record<string, unknown>>[] = [];
    walk(nodes, (el) => {
      if ((el.props as Record<string, unknown>)['data-msg-link'] === '') {
        found.push(el as ReactElement<Record<string, unknown>>);
      }
    });
    return found;
  };

  it('renders an external url as a new-tab anchor without the scheme', () => {
    const nodes = renderMessageBody('see https://example.com/a?b=1.', false, ORIGIN);
    const [a] = links(nodes);
    expect(a?.type).toBe('a');
    expect(a?.props.href).toBe('https://example.com/a?b=1');
    expect(a?.props.target).toBe('_blank');
    expect(a?.props.rel).toBe('noopener noreferrer');
    expect(a?.props.children).toBe('example.com/a?b=1');
    expect(nodes[0]).toBe('see ');
    expect(nodes[2]).toBe('.');
  });

  it('renders internal post and brief links as in-app router links', () => {
    const nodes = renderMessageBody(`${ORIGIN}/p/gbl-142 and ${ORIGIN}/b/gbl-7`, false, ORIGIN);
    const found = links(nodes);
    expect(found.map((el) => el.type)).toEqual([Link, Link]);
    expect(found.map((el) => el.props.to)).toEqual(['/p/gbl-142', '/b/gbl-7']);
    expect(found[0]?.props.children).toBe('app.example.test/p/gbl-142');
  });

  it('colours links per side: accent on a peer bubble, accent-fg on your own', () => {
    const body = `x https://example.com ${ORIGIN}/p/gbl-1`;
    for (const el of links(renderMessageBody(body, false, ORIGIN))) {
      expect(el.props.className).toBe('underline text-accent');
    }
    for (const el of links(renderMessageBody(body, true, ORIGIN))) {
      expect(el.props.className).toBe('underline text-accent-fg');
    }
  });

  it('the bubble body renders the link segments', () => {
    const root = renderBubble(makeMessage({ body: 'go https://example.com now', mine: true }));
    const found = links(root);
    expect(found).toHaveLength(1);
    expect(found[0]?.props.className).toBe('underline text-accent-fg');
  });

  it('plain text stays a single text run', () => {
    expect(renderMessageBody('no links here', false, ORIGIN)).toEqual(['no links here']);
  });

  it('a pointer on a non-element target is not a link tap', () => {
    expect(isLinkTarget(null)).toBe(false);
    expect(isLinkTarget({})).toBe(false);
  });
});

describe('ThreadHeaderIdentity', () => {
  const base = {
    title: 'Alice Doe',
    avatarUrl: null,
    presence: undefined,
    headerLine: 'Client · Acme',
    layout: 'touch' as const,
  };
  function buttons(root: ReactElement): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    walk(root, (el) => {
      if (el.type === 'button') out.push(el as ReactElement<Record<string, unknown>>);
    });
    return out;
  }

  it('a DM header is one 44px button spanning photo and name that opens the sheet', () => {
    const onOpenContact = vi.fn();
    const root = ThreadHeaderIdentity({ ...base, isGroup: false, onOpenContact });
    const [button] = buttons(root);
    expect(root.type).toBe('button');
    expect(String(button?.props.className)).toContain('min-h-[44px]');
    expect(hasAvatar(root)).toBe(true);
    expect(allText(root)).toContain('Alice Doe');
    (button?.props.onClick as () => void)();
    expect(onOpenContact).toHaveBeenCalledTimes(1);
  });

  it('a group header with the handler is one button that opens Group info', () => {
    const onOpen = vi.fn();
    const root = ThreadHeaderIdentity({ ...base, isGroup: true, onOpenContact: onOpen });
    expect(buttons(root)).toHaveLength(1);
    expect(allText(root)).toContain('Alice Doe');
  });

  it('a group header without the handler stays a plain block', () => {
    expect(buttons(ThreadHeaderIdentity({ ...base, isGroup: true }))).toEqual([]);
  });

  it('a DM without the handler renders no button', () => {
    expect(buttons(ThreadHeaderIdentity({ ...base, isGroup: false }))).toEqual([]);
  });
});

describe('post references', () => {
  const POST = { id: 'p1', number: 14, title: 'Launch teaser', thumbnailAssetVersionId: null };
  const card = makeMessage({ id: 'card', body: '', sharedPostIds: ['p1'], mine: true });
  const reply = makeMessage({
    id: 'r1',
    body: 'Can we swap the cover?',
    reply: { id: 'card', authorUserId: 'me', preview: 'Shared post' },
  });

  function bubbleWith(message: ThreadMessage, chip: ReturnType<typeof bubbleChip>): ReactElement {
    return MessageBubble({
      message,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: false,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: () => {},
      postRefs: { chip },
    });
  }

  function types(root: ReactElement): unknown[] {
    const found: unknown[] = [];
    walk(root, (el) => found.push(el.type));
    return found;
  }

  it('a reply to a card message renders the KEY chip instead of the quote; a tap jumps to the card', () => {
    const onOpenCard = vi.fn();
    const target = chipTargetFor(reply, parentIndexOf([card, reply]));
    expect(target).toEqual({ cardMessageId: 'card', postId: 'p1' });
    const chip = bubbleChip(target, POST, { workspaceKey: 'gbl', onOpenCard });
    const root = bubbleWith(reply, chip);
    expect(types(root)).toContain(PostRefChip);
    expect(types(root)).not.toContain(ReplyQuoteBox);
    let onTap: (() => void) | undefined;
    walk(root, (el) => {
      if (el.type === PostRefChip) onTap = (el.props as { onTap: () => void }).onTap;
    });
    onTap?.();
    expect(onOpenCard).toHaveBeenCalledWith('card');
  });

  it('a live row whose chip post is still being read keeps the plain quote (the chip comes later)', () => {
    const target = chipTargetFor(reply, parentIndexOf([card]));
    const chip = bubbleChip(target, undefined, { workspaceKey: 'gbl', onOpenCard: vi.fn() });
    expect(chip).toBeUndefined();
    const root = bubbleWith(reply, chip);
    expect(types(root)).not.toContain(PostRefChip);
    expect(types(root)).toContain(ReplyQuoteBox);
    let body: unknown;
    walk(root, (el) => {
      const props = el.props as { className?: string; children?: unknown };
      if (props.className === bodyText('touch')) body = props.children;
    });
    // The rendered body, then the meta spacer.
    expect((body as unknown[])[0]).toEqual(['Can we swap the cover?']);
  });

  it('keeps the quote for a plain parent or a post the viewer cannot see', () => {
    const plain = bubbleChip(null, undefined, { workspaceKey: 'gbl', onOpenCard: vi.fn() });
    expect(plain).toBeUndefined();
    expect(types(bubbleWith(reply, plain))).toContain(ReplyQuoteBox);
    const hidden = bubbleChip({ postId: 'p1', cardMessageId: 'card' }, null, {
      workspaceKey: null,
      onOpenCard: vi.fn(),
    });
    expect(types(bubbleWith(reply, hidden))).toContain(ReplyQuoteBox);
  });

  it('hands the card message id and the talk-about hook to its cards', () => {
    const onTalkAbout = vi.fn();
    const root = MessageBubble({
      message: card,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: false,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: () => {},
      postRefs: { onTalkAbout },
    });
    let props: { messageId?: string; onTalkAbout?: unknown } | undefined;
    walk(root, (el) => {
      if (el.type === SharedPostCards) props = el.props as typeof props;
    });
    expect(props?.messageId).toBe('card');
    expect(props?.onTalkAbout).toBe(onTalkAbout);
  });

  it('the thread view adds a 44px Load older row at the top that calls the loader', () => {
    const loadOlder = vi.fn();
    const items = threadListItems([], false, () => <li />, loadOlder);
    const row = items[1] as ReactElement<{ children: ReactElement }>;
    const button = row.props.children as ReactElement<{
      onClick: () => void;
      className: string;
      children: string;
    }>;
    expect(button.props.children).toBe('Load older');
    expect(button.props.className).toContain('min-h-[44px]');
    button.props.onClick();
    expect(loadOlder).toHaveBeenCalledTimes(1);
    // Not while a page is loading, and never without a loader.
    expect(threadListItems([], true, () => <li />, loadOlder).map((i) => i.key)).not.toContain(
      'load-older',
    );
    expect(threadListItems([], false, () => <li />).map((i) => i.key)).not.toContain('load-older');
  });

  it('a send with About set and no reply records p_reply_to_message_id = the card message', async () => {
    const rpc = vi.fn(() => ({
      abortSignal: () =>
        Promise.resolve({
          data: {
            id: 'new',
            channel_id: 'c1',
            workspace_id: 'ws',
            sender_user_id: 'me',
            body: 'swap the cover',
            mentions: null,
            attachment_asset_ids: null,
            shared_post_ids: null,
            shared_brief_ids: null,
            reply_to_message_id: 'card',
            forwarded_from_message_id: null,
            attachment_meta: null,
            agora_event_id: null,
            created_at: CREATED_AT,
            edited_at: null,
            deleted_at: null,
          },
          error: null,
        }),
    }));
    const client = { rpc } as unknown as Client;
    const about = aboutQuote({ cardMessageId: 'card' }, card);
    expect(about).toEqual({ id: 'card', authorUserId: 'peer-1', preview: 'Shared post' });
    const outcome = await runSend(
      {
        recordMessage: (input) => sendMessageRecord({ client, ...input }),
        publishLive: undefined,
        onLiveWarning: () => {},
      },
      {
        id: 'new',
        channelId: 'c1',
        currentUserId: 'me',
        traceId: 'trace',
        text: 'swap the cover',
        local: {
          attachments: [],
          sharedPostIds: [],
          sharedBriefIds: [],
          reply: replyForSend(null, about, false),
        },
      },
    );
    expect(outcome.ok).toBe(true);
    expect(rpc).toHaveBeenCalledWith(
      'chat_message_send',
      expect.objectContaining({ p_reply_to_message_id: 'card' }),
    );
  });

  it('a reply draft wins over About on send', () => {
    const draft = { id: 'quoted', authorUserId: null, preview: 'hi' };
    expect(replyForSend(draft, aboutQuote({ cardMessageId: 'card' }, card), false)?.id).toBe(
      'quoted',
    );
    expect(aboutQuote(null, undefined)).toBeNull();
    expect(aboutQuote({ cardMessageId: 'gone' }, undefined)).toEqual({
      id: 'gone',
      authorUserId: null,
      preview: 'Shared post',
    });
  });
});

describe('post references after audit', () => {
  const POST = { id: 'p1', number: 14, title: 'Launch teaser', thumbnailAssetVersionId: null };
  const card = makeMessage({ id: 'card', body: '', sharedPostIds: ['p1'], mine: true });
  const chipRow = makeMessage({
    id: 'r1',
    body: 'Swap the cover?',
    reply: { id: 'card', authorUserId: 'me', preview: 'Shared post' },
  });
  type Lookup = (id: string) => typeof POST | null | undefined;

  /**
   * MessageThread's render pipeline, step by step: the batch lookup and the
   * rows go through the same gate, chip and bubble functions the component
   * uses. Each distinct on-screen list is one list render. A lookup that has
   * not settled a post (undefined) is the read in flight, never a timeout.
   */
  function renderSteps(steps: Array<{ rows: ThreadMessage[]; lookup: Lookup }>): {
    renders: Array<Map<string, ReactElement>>;
    snaps: number;
  } {
    let gate: PageGate | null = null;
    let shown: ThreadMessage[] | null = null;
    const renders: Array<Map<string, ReactElement>> = [];
    let snaps = 0;
    let nowMs = 0;
    for (const step of steps) {
      nowMs += 1;
      const parentIndex = parentIndexOf(step.rows);
      const chipSettled = (id: string): boolean => step.lookup(id) !== undefined;
      const now = nowMs;
      const cut: { gate: PageGate; rows: ThreadMessage[] } = admitRows(
        gate,
        'thread',
        step.rows,
        (row: ThreadMessage, since: number) =>
          rowReady(row, since, { parentIndex, chipSettled, nowMs: now }),
        now,
      );
      gate = cut.gate;
      if (cut.rows.length === 0 || cut.rows === shown) continue;
      // ThreadBody's first snap: the first non-empty list it receives.
      if (shown === null) snaps += 1;
      const onScreen: ThreadMessage[] = cut.rows;
      shown = onScreen;
      const index = parentIndexOf(onScreen);
      const list = new Map<string, ReactElement>();
      for (const m of onScreen) {
        const target = chipTargetFor(m, index);
        const chip = bubbleChip(target, target !== null ? step.lookup(target.postId) : null, {
          workspaceKey: 'gbl',
          onOpenCard: () => {},
        });
        list.set(
          m.id,
          MessageBubble({
            message: m,
            profiles: PROFILES,
            cache,
            presignEnabled: false,
            showTicks: false,
            isGroup: false,
            head: true,
            tail: true,
            timeZone: 'UTC',
            layout: 'touch',
            onBadgeClick: () => {},
            postRefs: { chip },
          }),
        );
      }
      renders.push(list);
    }
    return { renders, snaps };
  }

  function has(root: ReactElement | undefined, type: unknown): boolean {
    let found = false;
    if (root !== undefined)
      walk(root, (el) => {
        if (el.type === type) found = true;
      });
    return found;
  }

  it('F7: a thread with chip rows renders its chips on the first render; the snap runs once', () => {
    const rows = [card, chipRow];
    const { renders, snaps } = renderSteps([
      { rows, lookup: () => undefined },
      { rows, lookup: () => undefined },
      { rows, lookup: () => POST },
    ]);
    expect(renders).toHaveLength(1);
    expect(snaps).toBe(1);
    expect(has(renders[0]?.get('r1'), PostRefChip)).toBe(true);
    expect(has(renders[0]?.get('r1'), ReplyQuoteBox)).toBe(false);
  });

  it('F7: a chip whose post resolves to null paints the plain quote first time', () => {
    const { renders } = renderSteps([
      { rows: [card, chipRow], lookup: () => undefined },
      { rows: [card, chipRow], lookup: () => null },
    ]);
    expect(renders).toHaveLength(1);
    expect(has(renders[0]?.get('r1'), ReplyQuoteBox)).toBe(true);
    expect(has(renders[0]?.get('r1'), PostRefChip)).toBe(false);
  });

  it('F7: an older page appears whole with its chips, never plain first', () => {
    const olderCard = makeMessage({ id: 'c0', body: '', sharedPostIds: ['p0'] });
    const olderChip = makeMessage({
      id: 'r0',
      body: 'older',
      reply: { id: 'c0', authorUserId: null, preview: 'Shared post' },
    });
    const first = [card, chipRow];
    const both = [olderCard, olderChip, ...first];
    const known: Lookup = (id) => (id === 'p1' ? POST : undefined);
    const { renders, snaps } = renderSteps([
      { rows: first, lookup: known },
      { rows: both, lookup: known },
      { rows: both, lookup: () => POST },
    ]);
    expect(renders).toHaveLength(2);
    expect(snaps).toBe(1);
    expect(renders[1]?.size).toBe(4);
    // Every chip row in every render carries its chip; none ever renders without it.
    for (const list of renders) {
      for (const id of ['r0', 'r1']) {
        if (list.has(id)) expect(has(list.get(id), PostRefChip)).toBe(true);
      }
    }
  });

  it('R3: a reply to a card on an unloaded page paints its chip on the first render of its page', () => {
    const unloaded = makeMessage({
      id: 'r9',
      body: 'about the older card',
      reply: { id: 'gone', authorUserId: null, preview: '' },
    });
    const hydrated = makeMessage({
      id: 'r9',
      body: 'about the older card',
      reply: { id: 'gone', authorUserId: 'peer-1', preview: 'Shared post' },
      parentSharedPostIds: ['p9'],
    });
    const p9 = { id: 'p9', number: 9, title: 'Older post', thumbnailAssetVersionId: null };
    const { renders, snaps } = renderSteps([
      { rows: [unloaded], lookup: () => undefined },
      { rows: [hydrated], lookup: () => undefined },
      { rows: [hydrated], lookup: (id) => (id === 'p9' ? p9 : undefined) },
    ]);
    expect(renders).toHaveLength(1);
    expect(snaps).toBe(1);
    expect(has(renders[0]?.get('r9'), PostRefChip)).toBe(true);
    expect(has(renders[0]?.get('r9'), ReplyQuoteBox)).toBe(false);
  });

  it('R4: an own send during a pending older-page chip read shows on the next render', () => {
    const t0 = Date.parse(CREATED_AT);
    const at = (min: number): Pick<ThreadMessage, 'time' | 'createdAt'> => ({
      time: t0 + min * 60_000,
      createdAt: new Date(t0 + min * 60_000).toISOString(),
    });
    const first = [
      { ...card, ...at(10) },
      { ...chipRow, ...at(11) },
    ];
    const older = [
      makeMessage({ id: 'c0', body: '', sharedPostIds: ['p0'], ...at(0) }),
      makeMessage({
        id: 'r0',
        body: 'old',
        reply: { id: 'c0', authorUserId: null, preview: 'Shared post' },
        ...at(1),
      }),
    ];
    const own = makeMessage({ id: 'own', body: 'hi', mine: true, state: 'sending', ...at(12) });
    const known: Lookup = (id) => (id === 'p1' ? POST : undefined);
    const { renders } = renderSteps([
      { rows: first, lookup: known },
      { rows: [...older, ...first, own], lookup: known },
      { rows: [...older, ...first, { ...own, state: 'sent' }], lookup: known },
    ]);
    expect(renders).toHaveLength(3);
    expect([...(renders[1]?.keys() ?? [])]).toEqual(['card', 'r1', 'own']);
    expect([...(renders[2]?.keys() ?? [])]).toEqual(['card', 'r1', 'own']);
    let state: unknown;
    walk(renders[2]?.get('own') as ReactElement, (el) => {
      const p = el.props as { 'data-msg-id'?: string; 'data-state'?: string };
      if (p['data-msg-id'] === 'own') state = p['data-state'];
    });
    expect(state).toBe('sent');
  });

  it('F8: an older page waiting on its chip post stays held; the row on screen stays', () => {
    const t0 = Date.parse(CREATED_AT);
    const at = (min: number): Pick<ThreadMessage, 'time' | 'createdAt'> => ({
      time: t0 + min * 60_000,
      createdAt: new Date(t0 + min * 60_000).toISOString(),
    });
    const shownReply = { ...chipRow, ...at(11) };
    const first = [shownReply];
    const olderCard = { ...card, ...at(1) };
    const otherChip = makeMessage({
      id: 'r0',
      body: 'about another post',
      reply: { id: 'c0', authorUserId: null, preview: 'Shared post' },
      parentSharedPostIds: ['p0'],
      ...at(2),
    });
    const all = [olderCard, otherChip, ...first];
    const known: Lookup = (id) => (id === 'p1' ? POST : undefined);
    let gate: PageGate | null = null;
    const cut = (rows: ThreadMessage[], nowMs: number) => {
      const parentIndex = parentIndexOf(rows);
      const next = admitRows(
        gate,
        'thread',
        rows,
        (row, since) =>
          rowReady(row, since, {
            parentIndex,
            chipSettled: (id) => known(id) !== undefined,
            nowMs,
          }),
        nowMs,
      );
      gate = next.gate;
      return next.rows;
    };
    cut(first, 1);
    const onScreen = cut(all, 2);
    expect(onScreen.map((m) => m.id)).toEqual(['r1']);
  });

  it('F14: About pending or gone attaches no reply_to on send', async () => {
    expect(aboutReplyFor({ cardMessageId: 'card' }, undefined, card)).toBeNull();
    expect(aboutReplyFor({ cardMessageId: 'card' }, null, card)).toBeNull();
    expect(aboutReplyFor({ cardMessageId: 'card' }, POST, card)?.id).toBe('card');
    expect(ABOUT_UNAVAILABLE_TOAST).toBe('That post is not available here');

    for (const post of [undefined, null]) {
      const rpc = vi.fn<(name: string, args: Record<string, unknown>) => unknown>(() => ({
        abortSignal: () => Promise.resolve({ data: { id: 'new' }, error: null }),
      }));
      const client = { rpc } as unknown as Client;
      await runSend(
        {
          recordMessage: (input) => sendMessageRecord({ client, ...input }),
          publishLive: undefined,
          onLiveWarning: () => {},
        },
        {
          id: 'new',
          channelId: 'c1',
          currentUserId: 'me',
          traceId: 'trace',
          text: 'hi',
          local: {
            attachments: [],
            sharedPostIds: [],
            sharedBriefIds: [],
            reply: replyForSend(null, aboutReplyFor({ cardMessageId: 'card' }, post, card), false),
          },
        },
      );
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc.mock.calls[0]?.[1]).not.toHaveProperty('p_reply_to_message_id');
    }
  });
});

describe('status ticker slot', () => {
  it('the ticker shows for threads with marks, never while selecting', () => {
    expect(threadStripSlot({ hasMarks: true, selecting: false })).toBe('loops');
    expect(threadStripSlot({ hasMarks: true, selecting: true })).toBeNull();
    expect(threadStripSlot({ hasMarks: false, selecting: false })).toBeNull();
  });
});

describe('status ticker first paint waits for every read (B1)', () => {
  const pending = (id: string, channelId: string, priority: 1 | null = null): ChatMark => ({
    messageId: id,
    channelId,
    type: 'pending',
    priority,
    markedAt: '2026-09-27T10:00:00Z',
    resolved: false,
    resolvedBy: null,
    resolvedAt: null,
  });
  const settled = {
    plans: { ready: true, failed: false, bundles: [] },
    briefs: { ready: true, failed: false, rows: [], count: 0 },
  };
  const side = { side: 'client' as const, ready: true };
  type Input = Parameters<typeof tickerBar>[0];
  const base = (over: Partial<Input>): Input => ({
    openPosts: { ready: true, count: 0, failed: false },
    side,
    marks: new Map(),
    marksLoaded: true,
    status: settled,
    open: [],
    ...over,
  });
  /** The bar as one line: each item's number and word. */
  const line = (input: Input): string | null => {
    const bar = tickerBar(input);
    if (bar === null) return null;
    if (bar.kind !== 'items') return bar.kind;
    return bar.items.map((i) => `${i.lead ?? ''}${i.number} ${i.word ?? ''}`.trim()).join(' · ');
  };

  it('posts lead the marks, pending P1 is warn', () => {
    const marks = new Map([['m1', pending('m1', 'c1', 1)]]);
    const input = base({
      openPosts: { ready: true, count: 4, failed: false },
      side: { side: 'agency', ready: true },
      marks,
    });
    expect(line(input)).toBe('4 in review · 1 pending');
    const bar = tickerBar(input);
    expect(bar?.kind === 'items' ? bar.items[1]?.tone : null).toBe('warn');
  });

  it('channel switch into a thread with marks: no bar until its marks are loaded', () => {
    const oldMarks = new Map([['a', pending('a', 'A')]]);
    const newMarks = new Map([
      ['b1', pending('b1', 'B')],
      ['b2', pending('b2', 'B')],
    ]);
    const posts = { ready: true, count: 1, failed: false };
    const frames = [
      line(base({ openPosts: { ...posts, ready: false }, marks: oldMarks, marksLoaded: false })),
      line(base({ openPosts: posts, marks: oldMarks, marksLoaded: false })),
      line(base({ openPosts: posts, marksLoaded: false })),
      line(base({ openPosts: posts, marks: newMarks })),
    ];
    expect(frames.slice(0, 3)).toEqual([null, null, null]);
    expect(frames[3]).toBe('1 waiting · 2 pending');
  });

  it('plans and briefs still settling hold the slot too', () => {
    expect(
      line(base({ status: { ...settled, plans: { ready: false, failed: false, bundles: [] } } })),
    ).toBeNull();
    expect(
      line(
        base({
          status: { ...settled, briefs: { ready: false, failed: false, rows: [], count: 0 } },
        }),
      ),
    ).toBeNull();
    expect(line(base({ side: { side: 'client', ready: false } }))).toBeNull();
  });

  it('nothing open only when every read succeeded; a failed posts read is blank', () => {
    expect(line(base({}))).toBe('empty');
    expect(line(base({ openPosts: { ready: true, count: null, failed: true } }))).toBe('blank');
    expect(
      line(
        base({
          openPosts: { ready: true, count: null, failed: true },
          marks: new Map([['c', pending('c', 'C')]]),
        }),
      ),
    ).toBe('1 pending');
  });
});

describe('tombstones, edited label and the neutral selection', () => {
  const noop = (): void => {};
  const press = {
    handlers: {
      onPointerDown: noop,
      onPointerMove: noop,
      onPointerUp: noop,
      onPointerCancel: noop,
    },
    onContextMenu: noop,
    consumeClick: () => false,
    onKeyOpen: noop,
    onMore: noop,
  };
  function render(
    message: ThreadMessage,
    over: Partial<Parameters<typeof MessageBubble>[0]> = {},
  ): ReactElement {
    return MessageBubble({
      message,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: true,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: noop,
      press,
      swipe: {},
      ...over,
    });
  }
  function all(root: ReactNode): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    walk(root, (el) => out.push(el as ReactElement<Record<string, unknown>>));
    return out;
  }

  const tomb = makeMessage({
    id: 'gone',
    body: '',
    deleted: true,
    reactions: [{ emoji: '👍', count: 2, mine: false }],
  });

  it('F8: a tombstone reads "You deleted this message" (own) or "This message was deleted", with its time', () => {
    expect(DELETED_OWN_LABEL).toBe('You deleted this message');
    expect(DELETED_OTHER_LABEL).toBe('This message was deleted');
    for (const mine of [false, true]) {
      const root = render({ ...tomb, mine });
      const html = renderStrip(root);
      expect(html).toContain(mine ? DELETED_OWN_LABEL : DELETED_OTHER_LABEL);
      expect(html).not.toContain(mine ? DELETED_OTHER_LABEL : DELETED_OWN_LABEL);
      expect(html).toContain(T_UTC);
      expect(html).toContain('data-meta-spacer');
      expect(html).toContain('data-tombstone');
      expect(html).toContain('<circle');
      expect(root.props).toMatchObject({ 'data-deleted': '' });
      const cls = tombstoneClass({ mine, head: false, tail: true, layout: 'touch' });
      expect(cls).toContain('border border-border');
      expect(cls).toContain('italic');
      expect(cls).toContain('text-fg-3');
      expect(cls).toContain(mine ? 'rounded-br-[4px]' : 'rounded-bl-[4px]');
      expect(String(root.props.className)).toContain(mine ? 'flex-row-reverse' : 'flex-row');
    }
  });

  it('a tombstone has no menu, no swipe-reply, no reactions and no checkbox', () => {
    const root = render(tomb, {
      selection: { role: 'none', checked: false, onToggle: noop },
    });
    const els = all(root);
    expect(els.some((el) => el.props.onPointerDown !== undefined)).toBe(false);
    expect(els.some((el) => el.props.onContextMenu !== undefined)).toBe(false);
    expect(els.some((el) => el.props['data-more'] !== undefined)).toBe(false);
    expect(els.some((el) => el.type === SwipeReplyIcon)).toBe(false);
    expect(els.some((el) => el.props.tabIndex !== undefined)).toBe(false);
    expect(renderStrip(root)).not.toContain('👍');
    expect(renderStrip(root)).not.toContain('role="checkbox"');
  });

  it('a deleted card message shows the tombstone, not the card', () => {
    const card = makeMessage({ id: 'card', body: '', sharedPostIds: ['post-1'] });
    expect(all(render(card)).some((el) => el.type === SharedPostCards)).toBe(true);
    const [deleted] = markMessagesDeleted([card], ['card']);
    if (deleted === undefined) throw new Error('expected the deleted card');
    const root = render(deleted);
    expect(all(root).some((el) => el.type === SharedPostCards)).toBe(false);
    const html = renderStrip(root);
    expect(html).toContain('data-tombstone');
    expect(html).toContain(DELETED_OTHER_LABEL);
  });

  it('a tombstone keeps its run slot: grouping is unchanged', () => {
    const t0 = Date.parse(CREATED_AT);
    const list = [
      makeMessage({ id: 'a', time: t0 }),
      makeMessage({ id: 'b', time: t0 + 1000, deleted: true, body: '' }),
      makeMessage({ id: 'c', time: t0 + 2000 }),
    ];
    const rows = threadRows(list, t0, 'UTC').filter(
      (r): r is Extract<ThreadRow, { kind: 'message' }> => r.kind === 'message',
    );
    expect(rows.map((r) => [r.message.id, r.head, r.tail])).toEqual([
      ['a', true, false],
      ['b', false, false],
      ['c', false, true],
    ]);
  });

  it('F8: a quote of a deleted message reads the same pair, italic and muted', () => {
    const quoteOf = (authorUserId: string): ReactElement<Record<string, unknown>> | undefined => {
      const reply = makeMessage({
        id: 'r',
        reply: { id: 'gone', authorUserId, preview: 'Message deleted' },
        parentDeleted: true,
      });
      return all(render(reply, { viewerUserId: 'me' })).find((el) => el.type === ReplyQuoteBox);
    };
    const other = quoteOf('peer-1');
    expect(other?.props).toMatchObject({ preview: DELETED_OTHER_LABEL, deleted: true });
    expect(renderStrip(other as ReactElement)).toMatch(
      new RegExp(`italic text-fg-3[^>]*>${DELETED_OTHER_LABEL}<`),
    );
    expect(quoteOf('me')?.props).toMatchObject({ preview: DELETED_OWN_LABEL, deleted: true });
  });

  it('an edited message shows "edited" before the time inside the bubble, also read aloud', () => {
    const edited = makeMessage({ editedAt: '2026-09-22T18:50:00Z' });
    const html = renderStrip(render(edited));
    expect(html).toMatch(
      new RegExp(
        `data-meta="inline"[^>]*><span data-edited="">edited</span><span[^>]*>${escapeRe(T_UTC)}`,
      ),
    );
    expect(bubbleTimeLabel(edited, 'UTC')).toBe(`${EDITED_LABEL}, ${T_UTC}`);
    expect(renderStrip(render(makeMessage({})))).not.toContain('data-edited');
    expect(renderStrip(render({ ...tomb, editedAt: 'x' }))).not.toContain('data-edited');
  });

  it('a checked row gets the neutral full-width tint; no accent ring on the bubble', () => {
    const checked = render(makeMessage({ mine: true }), {
      selection: { role: 'selectable', checked: true, onToggle: noop },
    });
    const els = all(checked);
    const tint = els.find((el) => el.props['data-selected-tint'] !== undefined);
    expect(tint?.props.className).toBe(SELECTED_ROW_TINT);
    expect(SELECTED_ROW_TINT).toContain('absolute inset-0');
    expect(SELECTED_ROW_TINT).toContain('bg-panel-3 opacity-60');
    expect(String(checked.props.className)).toContain('relative');
    expect(String(checked.props.className)).toContain('isolate');
    const bubble = els.find((el) => el.props['data-bubble'] !== undefined);
    // Only the keyboard focus ring (focus-visible:) may name the accent.
    const classes = String(bubble?.props.className).split(' ');
    expect(classes).not.toContain('ring-accent');
    expect(classes).not.toContain('ring-2');
    expect(classes.filter((c) => c.includes('accent') && !c.startsWith('focus-visible:'))).toEqual([
      'text-accent-fg',
    ]);
    expect(renderStrip(checked)).not.toContain('ring-2 ring-accent ring-offset');

    const unchecked = render(makeMessage({ mine: true }), {
      selection: { role: 'selectable', checked: false, onToggle: noop },
    });
    expect(all(unchecked).some((el) => el.props['data-selected-tint'] !== undefined)).toBe(false);
  });

  it('F8 rowSelection: a marked own message is selectable, deleted is not', () => {
    const selection = { selected: new Set<string>(['marked']), onToggle: noop };
    expect(rowSelection(makeMessage({ id: 'marked', mine: true }), selection)).toMatchObject({
      role: 'selectable',
      checked: true,
    });
    expect(rowSelection(makeMessage({ id: 'x', mine: true }), selection).role).toBe('selectable');
    expect(rowSelection(makeMessage({ id: 'p', mine: false }), selection).role).toBe('selectable');
    expect(rowSelection(makeMessage({ id: 'd', mine: true, deleted: true }), selection).role).toBe(
      'none',
    );
  });
});

describe('D7: long-press never selects text or shows the iOS callout', () => {
  const NO_SELECT = ['select-none', '[-webkit-touch-callout:none]'];
  const noop = (): void => {};
  const press = (coarse: boolean): NonNullable<Parameters<typeof MessageBubble>[0]['press']> => ({
    handlers: {
      onPointerDown: noop,
      onPointerMove: noop,
      onPointerUp: noop,
      onPointerCancel: noop,
    },
    onContextMenu: noop,
    consumeClick: () => false,
    onKeyOpen: noop,
    coarse,
  });
  function bubble(message: ThreadMessage, coarse = true): ReactElement<Record<string, unknown>> {
    return MessageBubble({
      message,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: true,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: noop,
      press: press(coarse),
      swipe: {},
    }) as ReactElement<Record<string, unknown>>;
  }
  function find(
    root: ReactElement,
    attr: string,
  ): ReactElement<Record<string, unknown>> | undefined {
    let hit: ReactElement<Record<string, unknown>> | undefined;
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (hit === undefined && props[attr] !== undefined)
        hit = el as ReactElement<Record<string, unknown>>;
    });
    return hit;
  }

  it('the thread container, every row and bubble carry select-none and the no-callout class', () => {
    for (const cls of NO_SELECT) expect(THREAD_LIST_CLASS.split(' ')).toContain(cls);
    const row = bubble(makeMessage({}));
    for (const cls of NO_SELECT) {
      expect(String(row.props.className).split(' ')).toContain(cls);
      expect(String(find(row, 'data-bubble')?.props.className).split(' ')).toContain(cls);
    }
    const tomb = bubble(makeMessage({ body: '', deleted: true }));
    for (const cls of NO_SELECT) {
      expect(String(tomb.props.className).split(' ')).toContain(cls);
      expect(String(find(tomb, 'data-tombstone')?.props.className).split(' ')).toContain(cls);
    }
  });

  it('no inline styles: the classes are arbitrary Tailwind values', () => {
    expect(bubble(makeMessage({})).props.style).toBeUndefined();
  });

  it('contextmenu default is prevented on a row on a coarse pointer only', () => {
    const preventDefault = vi.fn();
    const coarseRow = bubble(makeMessage({}), true);
    (coarseRow.props.onContextMenu as (e: { preventDefault: () => void }) => void)({
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
    // Laptop: the row leaves right-click alone (the bubble's own menu is unchanged).
    expect(bubble(makeMessage({}), false).props.onContextMenu).toBeUndefined();
  });

  it('bubble contextmenu: coarse = the hold owns it (no second menu); fine = right-click opens the menu', () => {
    const selection = (): RowSelection | undefined => undefined;
    const openMenu = vi.fn();
    const deps = {
      selection,
      openMenu,
      cancelTimer: noop,
      cancelSwipe: noop,
      swiping: () => false,
    };
    const coarse = createRowHold({ ...deps, coarse: () => true });
    const preventDefault = vi.fn();
    coarse.pointerDown();
    coarse.hold(); // the long-press timer fired first
    coarse.contextMenu({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(openMenu).toHaveBeenCalledOnce();
    const fine = createRowHold({ ...deps, coarse: () => false });
    fine.contextMenu({ preventDefault });
    expect(openMenu).toHaveBeenCalledTimes(2);
  });
});

describe('D8: WhatsApp multi-select', () => {
  const noop = (): void => {};
  function row(
    message: ThreadMessage,
    selection: RowSelection | undefined,
  ): ReactElement<Record<string, unknown>> {
    return MessageBubble({
      message,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: true,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: noop,
      press: {
        handlers: {
          onPointerDown: noop,
          onPointerMove: noop,
          onPointerUp: noop,
          onPointerCancel: noop,
        },
        onContextMenu: noop,
        consumeClick: () => false,
        onKeyOpen: noop,
        coarse: true,
      },
      swipe: {},
      ...(selection !== undefined ? { selection } : {}),
    }) as ReactElement<Record<string, unknown>>;
  }
  function nodes(root: ReactElement): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    walk(root, (el) => out.push(el as ReactElement<Record<string, unknown>>));
    return out;
  }
  const selectable = (onToggle: () => void, checked = false): RowSelection => ({
    role: 'selectable',
    checked,
    onToggle,
  });

  // A row in selection mode as the browser sees it: an event target carrying
  // the rendered row's own React handlers (if any) plus the row's selection
  // gesture, driven by dispatched pointer, contextmenu and click events.
  const REACT_EVENTS: Record<string, [string, boolean]> = {
    onPointerDown: ['pointerdown', false],
    onPointerMove: ['pointermove', false],
    onPointerUp: ['pointerup', false],
    onPointerCancel: ['pointercancel', false],
    onContextMenu: ['contextmenu', false],
    onClick: ['click', false],
    onClickCapture: ['click', true],
  };
  function liveRow(
    selection: RowSelection,
    coarse = true,
  ): { target: EventTarget; detach: () => void } {
    const target = new EventTarget();
    const rendered = row(makeMessage({}), selection);
    for (const [prop, [type, capture]] of Object.entries(REACT_EVENTS)) {
      const handler = rendered.props[prop];
      if (typeof handler === 'function') {
        target.addEventListener(type, (e) => (handler as (e: Event) => void)(e), capture);
      }
    }
    const detach = createSelectionGesture({
      selection: () => selection,
      coarse: () => coarse,
    }).attach(target);
    return { target, detach };
  }
  function fire(
    target: EventTarget,
    type: string,
    at: { x?: number; y?: number; pointerType?: string; button?: number } = {},
  ): Event {
    const event = Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
      clientX: at.x ?? 0,
      clientY: at.y ?? 0,
      pointerType: at.pointerType ?? 'touch',
      button: at.button ?? 0,
    });
    target.dispatchEvent(event);
    return event;
  }
  /** A finger (or mouse) down, optionally moved, and up, then the click the browser sends. */
  function press(target: EventTarget, moveTo?: { x: number; y: number }, pointerType = 'touch') {
    fire(target, 'pointerdown', { x: 100, y: 100, pointerType });
    if (moveTo !== undefined) fire(target, 'pointermove', { ...moveTo, pointerType });
    fire(target, 'pointerup', { ...(moveTo ?? { x: 100, y: 100 }), pointerType });
    return fire(target, 'click');
  }

  it('menu Select, Forward and Delete enter the mode with that message ticked, marked ones too', () => {
    const own = makeMessage({ id: 'own', mine: true });
    const peer = makeMessage({ id: 'peer', mine: false });
    expect([...selectionOnEntry(own)]).toEqual(['own']);
    expect([...selectionOnEntry(peer)]).toEqual(['peer']);
    expect(forwardEntersSelection(peer, true)).toBe(true);
    // F8: a marked own message is ticked like any other (the mark blocks Delete only).
    expect(forwardEntersSelection(own, true)).toBe(true);
    expect(forwardEntersSelection(own, false)).toBe(false);
  });

  it('F12: pointerdown + pointerup with no move toggles once; the trailing click is swallowed', () => {
    const onToggle = vi.fn();
    const { target } = liveRow(selectable(onToggle));
    const click = press(target);
    expect(onToggle).toHaveBeenCalledOnce();
    // Nothing inside opens: the click is cancelled in capture.
    expect(click.defaultPrevented).toBe(true);
    // A mouse tap toggles once too.
    press(target, undefined, 'mouse');
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('F12: pointerdown + a move over 10px (a scroll or drag) never toggles, even when a click follows', () => {
    const onToggle = vi.fn();
    const { target } = liveRow(selectable(onToggle));
    press(target, { x: 100, y: 111 });
    press(target, { x: 111, y: 100 }, 'mouse');
    expect(onToggle).not.toHaveBeenCalled();
    // Within 10px is still a tap.
    press(target, { x: 106, y: 106 });
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it('F12: pointercancel never toggles and leaves nothing armed (no freeze)', () => {
    vi.useFakeTimers();
    try {
      const onToggle = vi.fn();
      const { target } = liveRow(selectable(onToggle));
      fire(target, 'pointerdown', { x: 100, y: 100 });
      fire(target, 'pointercancel');
      // The hold timer is gone: time passing toggles nothing.
      vi.advanceTimersByTime(2000);
      expect(onToggle).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      // The next tap works at once.
      press(target);
      expect(onToggle).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('F12: contextmenu during a hold on a coarse pointer is prevented, toggles once, and the click is swallowed once', () => {
    vi.useFakeTimers();
    try {
      const onToggle = vi.fn();
      const { target } = liveRow(selectable(onToggle), true);
      fire(target, 'pointerdown', { x: 100, y: 100 });
      const menu = fire(target, 'contextmenu');
      expect(menu.defaultPrevented).toBe(true);
      expect(onToggle).toHaveBeenCalledOnce();
      // The hold timer no longer fires a second toggle; release and click do nothing.
      vi.advanceTimersByTime(1000);
      fire(target, 'pointerup', { x: 100, y: 100 });
      const click = fire(target, 'click');
      expect(click.defaultPrevented).toBe(true);
      expect(onToggle).toHaveBeenCalledOnce();
      // Swallowed once only: a keyboard click on the circle (no press) toggles.
      fire(target, 'click');
      expect(onToggle).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a touch hold toggles once and opens no menu; its release and click do not toggle back', () => {
    vi.useFakeTimers();
    try {
      const onToggle = vi.fn();
      const { target } = liveRow(selectable(onToggle));
      fire(target, 'pointerdown', { x: 100, y: 100 });
      vi.advanceTimersByTime(450);
      expect(onToggle).toHaveBeenCalledOnce();
      fire(target, 'pointerup', { x: 100, y: 100 });
      fire(target, 'click');
      expect(onToggle).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the row, not only the bubble, is the target; the bubble carries no selection handlers', () => {
    const root = row(makeMessage({}), selectable(noop));
    expect(root.type).toBe('li');
    const bubbleEl = nodes(root).find((el) => el.props['data-bubble'] !== undefined);
    expect(bubbleEl?.props.onPointerDown).toBeUndefined();
    // The circle is a 44x44 check in the left column.
    expect(nodes(root).find((el) => el.type === SelectCheckbox)).toBeDefined();
    expect(renderStrip(root)).toContain('h-11 w-11');
    expect(String(root.props.className)).toContain(SELECTION_ROW_OFFSET);
  });

  it('detach removes every listener and stops the hold timer', () => {
    vi.useFakeTimers();
    try {
      const onToggle = vi.fn();
      const { target, detach } = liveRow(selectable(onToggle));
      fire(target, 'pointerdown', { x: 100, y: 100 });
      detach();
      expect(vi.getTimerCount()).toBe(0);
      press(target);
      expect(onToggle).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('F6: while selecting, cards get no talkAbout, so a hold on a card only toggles the row', () => {
    const talk = vi.fn();
    const refs = { onTalkAbout: talk, onOpenThread: noop };
    expect(cardRefsFor('m1', selectable(noop), refs).onTalkAbout).toBeUndefined();
    expect(cardRefsFor('m1', undefined, refs).onTalkAbout).toBe(talk);
    // The card inside the row renders without its own hold handlers.
    const onToggle = vi.fn();
    const card = makeMessage({ sharedPostIds: ['post-1'] });
    const rendered = MessageBubble({
      message: card,
      profiles: PROFILES,
      cache,
      presignEnabled: false,
      showTicks: true,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      onBadgeClick: noop,
      selection: selectable(onToggle),
      postRefs: refs,
    });
    const cards = nodes(rendered).filter((el) => 'onTalkAbout' in el.props);
    expect(cards.length).toBeGreaterThan(0);
    for (const el of cards) expect(el.props.onTalkAbout).toBeUndefined();
    // The row's hold toggles it (and talks about nothing).
    vi.useFakeTimers();
    try {
      const { target } = liveRow(selectable(onToggle));
      fire(target, 'pointerdown', { x: 100, y: 100 });
      vi.advanceTimersByTime(450);
      fire(target, 'pointerup', { x: 100, y: 100 });
      fire(target, 'click');
    } finally {
      vi.useRealTimers();
    }
    expect(onToggle).toHaveBeenCalledOnce();
    expect(talk).not.toHaveBeenCalled();
  });

  it('swipe-to-reply is off in the mode', () => {
    const root = row(makeMessage({}), selectable(noop));
    const bubbleEl = nodes(root).find((el) => el.props['data-bubble'] !== undefined);
    expect(bubbleEl?.props['data-swipe-reply']).toBeUndefined();
  });

  it('a tombstone has no circle, keeps the column offset and cannot be toggled', () => {
    const onToggle = vi.fn();
    const tomb = makeMessage({ body: '', deleted: true });
    const root = row(tomb, { role: 'none', checked: false, onToggle });
    expect(nodes(root).some((el) => el.type === SelectCheckbox)).toBe(false);
    expect(String(root.props.className)).toContain(SELECTION_ROW_OFFSET);
    expect(root.props.onClickCapture).toBeUndefined();
    // Its gesture never toggles (role none), yet the click is still swallowed.
    const { target } = liveRow({ role: 'none', checked: false, onToggle });
    expect(press(target).defaultPrevented).toBe(true);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('zero selected stays in the mode: pruning empties the set but never ends selection', () => {
    const list = [makeMessage({ id: 'a', mine: true })];
    const pruned = rowSelection(list[0] as ThreadMessage, { selected: new Set(), onToggle: noop });
    expect(pruned).toMatchObject({ role: 'selectable', checked: false });
  });

  it('the check circle fades on opacity only; no layout animation on the row', () => {
    const root = row(makeMessage({}), selectable(noop));
    const circle = nodes(root).find((el) => el.type === SelectCheckbox);
    const html = renderStrip(circle as ReactElement);
    expect(html).toContain('transition-opacity');
    expect(html).toContain('[@starting-style]:opacity-0');
    expect(String(root.props.className)).not.toMatch(/transition|translate-x|animate/);
  });
});

describe('F7: system back and iOS swipe-back exit selection first', () => {
  // A browser history stack: pushState adds, back() pops then fires popstate.
  function fakeWindow(url: string): SelectionHistoryWindow & {
    stack: { state: unknown; url: string }[];
    index: () => number;
    navigate: (to: string) => void;
    listeners: () => number;
  } {
    const stack = [{ state: { idx: 0 } as unknown, url }];
    let i = 0;
    const listeners = new Set<() => void>();
    const pop = (): void => {
      for (const l of [...listeners]) l();
    };
    return {
      stack,
      index: () => i,
      listeners: () => listeners.size,
      navigate: (to) => {
        stack.splice(i + 1);
        stack.push({ state: { idx: i + 1 }, url: to });
        i += 1;
      },
      history: {
        get state() {
          return stack[i]?.state;
        },
        pushState: (data, _unused, next) => {
          stack.splice(i + 1);
          stack.push({ state: data, url: next ?? stack[i]?.url ?? url });
          i += 1;
        },
        back: () => {
          if (i === 0) return;
          i -= 1;
          pop();
        },
      },
      location: {
        get href() {
          return stack[i]?.url ?? url;
        },
      },
      addEventListener: (_type, l) => listeners.add(l),
      removeEventListener: (_type, l) => listeners.delete(l),
    };
  }
  const CHAT = 'https://v2.srtd.io/chat?channel=c1';

  it('entering pushes one marker at the same URL (with ?channel=); back exits and stays in the chat', () => {
    resetSelectionHistory();
    const win = fakeWindow(CHAT);
    const onExit = vi.fn();
    enterSelectionHistory(win, onExit);
    expect(win.stack).toHaveLength(2);
    expect(win.stack[1]?.url).toBe(CHAT);
    expect(win.stack[1]?.state).toMatchObject({
      idx: 0,
      [SELECTION_HISTORY_KEY]: expect.any(Number),
    });
    win.history.back();
    expect(onExit).toHaveBeenCalledOnce();
    expect(win.location.href).toBe(CHAT);
    expect(win.index()).toBe(0);
    expect(win.listeners()).toBe(0);
  });

  it('Cancel (and Escape, the chevron) pops the marker through history.back()', () => {
    resetSelectionHistory();
    const win = fakeWindow(CHAT);
    const onExit = vi.fn();
    const entry = enterSelectionHistory(win, onExit);
    const back = vi.spyOn(win.history, 'back');
    entry.cancel();
    expect(back).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
    expect(win.index()).toBe(0);
    // The effect cleanup after the exit does nothing more.
    entry.dispose();
    expect(back).toHaveBeenCalledOnce();
  });

  it('selection ending another way (delete, forward, unmount) pops its marker', () => {
    resetSelectionHistory();
    const win = fakeWindow(CHAT);
    const onExit = vi.fn();
    enterSelectionHistory(win, onExit).dispose();
    expect(win.index()).toBe(0);
    expect(onExit).not.toHaveBeenCalled();
    expect(win.listeners()).toBe(0);
  });

  it('leaving the chat while selecting leaves no stale entry: a buried marker is skipped', () => {
    resetSelectionHistory();
    const win = fakeWindow(CHAT);
    const entry = enterSelectionHistory(win, vi.fn());
    win.navigate('https://v2.srtd.io/pipeline');
    entry.dispose();
    // Back from the new page lands on the chat once, never on the dead marker.
    win.history.back();
    expect(win.index()).toBe(0);
    expect(win.location.href).toBe(CHAT);
    resetSelectionHistory();
    expect(win.listeners()).toBe(0);
  });
});

describe('R6: selection history, switch, bound and double back', () => {
  // A history stack whose traversals queue (like a browser's): back() only
  // enqueues; flush() runs them in order, firing popstate after each.
  function queuedWindow(urls: string[]): SelectionHistoryWindow & {
    index: () => number;
    url: () => string;
    flush: () => void;
    navigate: (to: string) => void;
    replace: (to: string) => void;
  } {
    const stack = urls.map((u, idx) => ({ state: { idx } as unknown, url: u }));
    let i = stack.length - 1;
    const queue: (() => void)[] = [];
    const listeners = new Set<() => void>();
    return {
      index: () => i,
      url: () => stack[i]?.url ?? '',
      flush: () => {
        while (queue.length > 0) queue.shift()?.();
      },
      navigate: (to) => {
        stack.splice(i + 1);
        stack.push({ state: { idx: i + 1 }, url: to });
        i += 1;
      },
      replace: (to) => {
        stack[i] = { state: { idx: i }, url: to };
      },
      history: {
        get state() {
          return stack[i]?.state;
        },
        pushState: (data, _unused, next) => {
          stack.splice(i + 1);
          stack.push({ state: data, url: next ?? '' });
          i += 1;
        },
        back: () => {
          queue.push(() => {
            if (i === 0) return;
            i -= 1;
            for (const l of [...listeners]) l();
          });
        },
      },
      location: {
        get href() {
          return stack[i]?.url ?? '';
        },
      },
      addEventListener: (_type, l) => listeners.add(l),
      removeEventListener: (_type, l) => listeners.delete(l),
    };
  }
  const HOME = 'https://v2.srtd.io/pipeline';
  const LIST = 'https://v2.srtd.io/chat';
  const CHAT = 'https://v2.srtd.io/chat?channel=c1';
  const OTHER = 'https://v2.srtd.io/chat?channel=c2';

  it('a channel switch while selecting exits selection through history.back(), then switches', () => {
    resetSelectionHistory();
    const win = queuedWindow([HOME, CHAT]);
    const order: string[] = [];
    const entry = enterSelectionHistory(win, () => order.push('exit'));
    const back = vi.spyOn(win.history, 'back');
    leaveSelectionThen(() => {
      order.push('switch');
      win.replace(OTHER);
    });
    expect(back).toHaveBeenCalledOnce();
    expect(order).toEqual([]);
    win.flush();
    expect(order).toEqual(['exit', 'switch']);
    entry.dispose();
    // No marker left: back from the new chat leaves the chat, it never shows c1.
    expect(win.url()).toBe(OTHER);
    win.history.back();
    win.flush();
    expect(win.url()).toBe(HOME);
    // Not selecting: the switch runs at once.
    const run = vi.fn();
    leaveSelectionThen(run);
    expect(run).toHaveBeenCalledOnce();
  });

  it('S3: New chat while selecting exits first; the pending switch survives dispose()', () => {
    resetSelectionHistory();
    const win = queuedWindow([HOME, CHAT]);
    const order: string[] = [];
    const entry = enterSelectionHistory(win, () => order.push('exit'));
    const back = vi.spyOn(win.history, 'back');
    // ChannelList's New chat and ChatConnected's onDmReady both go through this.
    leaveSelectionThen(() => {
      order.push('open');
      win.replace(OTHER);
    });
    expect(back).toHaveBeenCalledOnce();
    expect(order).toEqual([]);
    // The thread unmounts while history.back() is still pending.
    entry.dispose();
    expect(order).toEqual([]);
    win.flush();
    expect(order).toEqual(['open']);
    expect(win.url()).toBe(OTHER);
  });

  it('buried markers are bounded to the most recent 20; one guard listener', () => {
    resetSelectionHistory();
    const win = queuedWindow([HOME, CHAT]);
    for (let n = 0; n < BURIED_MARKERS_LIMIT + 15; n += 1) {
      const entry = enterSelectionHistory(win, vi.fn());
      win.navigate(`${LIST}?n=${n}`);
      entry.dispose();
    }
    expect(buriedMarkerCount()).toBe(BURIED_MARKERS_LIMIT);
    resetSelectionHistory();
    expect(buriedMarkerCount()).toBe(0);
  });

  it('two back presses in quick succession after a buried marker never skip past the chat list', () => {
    resetSelectionHistory();
    const win = queuedWindow([HOME, LIST, CHAT]);
    const entry = enterSelectionHistory(win, vi.fn());
    win.navigate('https://v2.srtd.io/posts');
    entry.dispose();
    // Both presses land before any popstate is handled.
    win.history.back();
    win.history.back();
    win.flush();
    expect(win.url()).toBe(LIST);
    // Pressed one at a time: the same.
    resetSelectionHistory();
    const win2 = queuedWindow([HOME, LIST, CHAT]);
    const entry2 = enterSelectionHistory(win2, vi.fn());
    win2.navigate('https://v2.srtd.io/posts');
    entry2.dispose();
    win2.history.back();
    win2.flush();
    expect(win2.url()).toBe(CHAT);
    win2.history.back();
    win2.flush();
    expect(win2.url()).toBe(LIST);
  });

  it('a double Cancel (chevron, Escape) pops the marker once and stays in the chat', () => {
    resetSelectionHistory();
    const win = queuedWindow([LIST, CHAT]);
    const onExit = vi.fn();
    const entry = enterSelectionHistory(win, onExit);
    const back = vi.spyOn(win.history, 'back');
    entry.cancel();
    entry.cancel();
    win.flush();
    expect(back).toHaveBeenCalledOnce();
    expect(onExit).toHaveBeenCalledOnce();
    expect(win.url()).toBe(CHAT);
  });
});

describe('F11: selection entry keeps the pressed row at its screen Y', () => {
  // A list whose rows sit at a layout offset minus the scroll; the check
  // column rewraps the bubbles above the pressed row, moving it down.
  function fakeList(): AnchorList & { rewrap: (px: number) => void; rowTop: () => number } {
    let layoutShift = 0;
    const list = {
      scrollTop: 400,
      rewrap: (px: number) => {
        layoutShift += px;
      },
      rowTop: () => 900 + layoutShift - list.scrollTop,
      querySelector: (selector: string) =>
        selector === '[data-msg-id="pressed"]'
          ? { getBoundingClientRect: () => ({ top: list.rowTop() }) }
          : null,
    };
    return list;
  }

  it('the anchored row keeps its Y, instantly, after the bubbles rewrap', () => {
    const list = fakeList();
    const anchor = captureRowAnchor(list, 'pressed');
    expect(anchor).toEqual({ id: 'pressed', top: 500 });
    list.rewrap(37);
    expect(list.rowTop()).toBe(537);
    expect(restoreRowAnchor(list, anchor as RowAnchor)).toBe(37);
    expect(list.rowTop()).toBe(500);
    expect(list.scrollTop).toBe(437);
  });

  it('a row that is not rendered anchors nothing', () => {
    const list = fakeList();
    expect(captureRowAnchor(list, 'other')).toBeNull();
    expect(restoreRowAnchor(list, { id: 'other', top: 10 })).toBe(0);
    expect(list.scrollTop).toBe(400);
  });

  it('R8a: exit keeps the anchor row at its Y too (re-taken just before exit)', () => {
    const list = fakeList();
    const scroll = createSelectionScroll();
    scroll.anchorEntry(list, 'pressed');
    list.rewrap(37);
    const entry = scroll.entered(false);
    restoreRowAnchor(list, entry as RowAnchor);
    expect(list.rowTop()).toBe(500);
    // The reader scrolls a little while selecting, then exits.
    list.scrollTop += 20;
    scroll.beforeExit(list);
    list.rewrap(-37);
    const plan = scroll.exited();
    expect(plan).toEqual({ pin: false, anchor: { id: 'pressed', top: 480 } });
    if (!plan.pin && plan.anchor !== null) restoreRowAnchor(list, plan.anchor);
    expect(list.rowTop()).toBe(480);
    expect(scroll.pending()).toBeNull();
  });

  it('R8b: re-pins on exit only when the thread was pinned at entry', () => {
    const list = fakeList();
    const pinned = createSelectionScroll();
    pinned.anchorEntry(list, 'pressed');
    pinned.entered(true);
    pinned.beforeExit(list);
    expect(pinned.exited()).toEqual({ pin: true });
    const reading = createSelectionScroll();
    reading.anchorEntry(list, 'pressed');
    reading.entered(false);
    reading.beforeExit(list);
    expect(reading.exited()).toMatchObject({ pin: false });
    // The next selection starts clean: not pinned, no anchor.
    reading.entered(false);
    expect(reading.exited()).toEqual({ pin: false, anchor: null });
  });

  it('R8c: menu Forward that opens the picker (no selection) clears the anchor', () => {
    const list = fakeList();
    const scroll = createSelectionScroll();
    scroll.anchorEntry(list, 'pressed');
    expect(scroll.pending()).not.toBeNull();
    scroll.cancelEntry();
    expect(scroll.pending()).toBeNull();
    // A later selection entered some other way restores nothing stale.
    expect(scroll.entered(false)).toBeNull();
    scroll.beforeExit(list);
    expect(scroll.exited()).toEqual({ pin: false, anchor: null });
  });
});

describe('F14: a failed mark never shows raw error text', () => {
  it('maps any failure to the fixed mark copy; success shows nothing', () => {
    expect(markOutcomeCopy({ ok: false, message: 'new row violates row-level security' })).toBe(
      "Couldn't mark, try again",
    );
    expect(markOutcomeCopy({ ok: true })).toBeNull();
  });
});

describe('@mentions in bubbles', () => {
  const ME = '11111111-1111-4111-8111-111111111111';
  const BEN = '22222222-2222-4222-8222-222222222222';
  const GONE = '99999999-9999-4999-8999-999999999999';
  const names: Map<string, ChatProfile> = new Map([
    [ME, { userId: ME, displayName: 'Me Person', avatarUrl: null }],
    [BEN, { userId: BEN, displayName: 'Ben', avatarUrl: null }],
  ]);
  const nameOf = profileNameOf(names, 'w1');
  const body = `hi @[${BEN}], @[${ME}] and @[${GONE}]`;

  function markup(mine: boolean, onOpen = vi.fn(), peerUserId: string | null = null): string {
    return renderStrip(
      <p>
        {renderBodyWithMentions(body, mine, {
          nameOf,
          viewerUserId: ME,
          mentions: { peerUserId, onOpen },
        })}
      </p>,
    );
  }

  it('turns every token into "@Name", unknown into "@Unknown member", never a raw token', () => {
    const html = markup(false);
    expect(html).toContain('@Ben');
    expect(html).toContain('@Me Person');
    expect(html).toContain('@Unknown member');
    expect(html).not.toContain('@[');
  });

  it('styles like the bubble link colour (own and peer) and bolds a mention of me', () => {
    expect(mentionClass(true, false)).toContain('text-accent-fg');
    expect(mentionClass(false, false)).toContain('text-accent');
    expect(mentionClass(false, true)).toContain('font-bold');
    const own = markup(true);
    const peer = markup(false);
    expect(own).toContain('text-accent-fg');
    expect(peer).not.toContain('text-accent-fg');
    expect(peer).toMatch(/data-mention="11111111[^"]*" class="[^"]*font-bold/);
  });

  it('tapping another person opens the DM via the opener; my own name is inert', () => {
    const onOpen = vi.fn();
    const nodes = renderBodyWithMentions(body, false, {
      nameOf,
      viewerUserId: ME,
      mentions: { peerUserId: null, onOpen },
    });
    const els = nodes.filter(isValidElement) as ReactElement<Record<string, unknown>>[];
    const ben = els.find((el) => el.props['data-mention'] === BEN);
    const me = els.find((el) => el.props['data-mention'] === ME);
    expect(ben?.type).toBe('button');
    expect(String(ben?.props.className)).toContain('before:h-[44px]');
    (ben?.props.onClick as () => void)();
    expect(onOpen).toHaveBeenCalledWith(BEN);
    expect(me?.type).toBe('span');
    expect(me?.props.onClick).toBeUndefined();
  });

  it("inside our DM the other person's name is inert", () => {
    const html = markup(false, vi.fn(), BEN);
    expect(html).not.toContain('<button');
  });

  it('a bubble and its reply quote show names, never tokens', () => {
    const message = makeMessage({
      body,
      reply: { id: 'q1', authorUserId: BEN, preview: `ask @[${ME}]` },
    });
    const root = MessageBubble({
      message,
      profiles: names,
      cache,
      presignEnabled: false,
      showTicks: false,
      isGroup: false,
      head: true,
      tail: true,
      timeZone: 'UTC',
      layout: 'touch',
      viewerUserId: ME,
      mentions: { peerUserId: null, onOpen: () => {} },
      onBadgeClick: () => {},
    });
    const texts: string[] = [];
    const labels: string[] = [];
    walk(root, (el) => {
      const props = el.props as Record<string, unknown>;
      if (typeof props.children === 'string') texts.push(props.children);
      if (typeof props.preview === 'string') labels.push(props.preview);
      if (props['data-mention'] !== undefined) texts.push(String(props.children));
    });
    expect(texts).toContain('@Ben');
    expect(labels).toContain('ask @Me Person');
    expect([...texts, ...labels].join(' ')).not.toContain('@[');
  });

  it('copy to clipboard reads "@Name"', () => {
    expect(resolveMentionText(body, nameOf)).toBe('hi @Ben, @Me Person and @Unknown member');
  });

  it('a body with no mention renders exactly as before', () => {
    expect(renderBodyWithMentions('plain', false, { nameOf, viewerUserId: ME })).toEqual(
      renderMessageBody('plain', false),
    );
  });
});

describe('F5 mentions are bold and the peer ink clears 4.5:1 in both themes', () => {
  // Read the theme tokens straight from src/index.css (read only). The hex sign
  // is built from its char code so this chat file stays hash-free.
  const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8');
  const HASH = String.fromCharCode(35);

  function tokens(selector: string): Map<string, string> {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf('}', start));
    const out = new Map<string, string>();
    const pattern = new RegExp(`--([\\w-]+):\\s*${HASH}([0-9a-f]{6});`, 'gi');
    for (const match of body.matchAll(pattern)) out.set(match[1] ?? '', match[2] ?? '');
    return out;
  }

  function rgb(hex: string): number[] {
    return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  }

  function luminance(channels: number[]): number {
    const [r = 0, g = 0, b = 0] = channels.map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function ratio(a: number[], b: number[]): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  }

  /** accent-soft: the accent at 10% (light) / 16% (dark) over the peer bubble. */
  function tint(accent: number[], alpha: number, under: number[]): number[] {
    return accent.map((v, i) => Math.round(alpha * v + (1 - alpha) * (under[i] ?? 0)));
  }

  const light = tokens(':root');
  const dark = tokens('.dark');
  const at = (theme: Map<string, string>, name: string): number[] => rgb(theme.get(name) ?? '');

  it('F5 peer mention ink (accent-hover) on the peer bubble (panel-2) is at least 4.5:1, light and dark', () => {
    expect(mentionClass(false, false)).toContain('text-accent-hover');
    const lightRatio = ratio(at(light, 'accent-hover'), at(light, 'panel-2'));
    const darkRatio = ratio(at(dark, 'accent-hover'), at(dark, 'panel-2'));
    expect(lightRatio).toBeGreaterThanOrEqual(4.5);
    expect(darkRatio).toBeGreaterThanOrEqual(4.5);
    expect(lightRatio.toFixed(2)).toBe('5.32');
    expect(darkRatio.toFixed(2)).toBe('5.58');
    // The accent the peer mention used before fails (4.23 light, 4.48 dark).
    expect(ratio(at(light, 'accent'), at(light, 'panel-2'))).toBeLessThan(4.5);
    expect(ratio(at(dark, 'accent'), at(dark, 'panel-2'))).toBeLessThan(4.5);
    // A mention of me also sits on accent-soft: the ink still clears 4.5:1 there.
    const selfLight = ratio(
      at(light, 'accent-hover'),
      tint(at(light, 'accent'), 0.1, at(light, 'panel-2')),
    );
    const selfDark = ratio(
      at(dark, 'accent-hover'),
      tint(at(dark, 'accent'), 0.16, at(dark, 'panel-2')),
    );
    expect(selfLight).toBeGreaterThanOrEqual(4.5);
    expect(selfDark).toBeGreaterThanOrEqual(4.5);
  });

  it('F5 every mention is font-bold in own and peer bubbles; a mention of me adds accent-soft', () => {
    for (const mine of [true, false]) {
      expect(mentionClass(mine, false)).toContain('font-bold');
      expect(mentionClass(mine, true)).toContain('font-bold');
      expect(mentionClass(mine, true)).toContain('bg-accent-soft');
      expect(mentionClass(mine, false)).not.toContain('bg-accent-soft');
    }
    expect(mentionClass(true, false)).toContain('text-accent-fg');
  });
});

describe('A3 "@all" renders bold, as a mention of me for recipients, and inert', () => {
  const names = new Map<string, ChatProfile>();

  function allMarkup(mine: boolean): string {
    return renderStrip(
      <p>
        {renderBodyWithMentions('@[all] standup', mine, {
          nameOf: profileNameOf(names, 'w1'),
          viewerUserId: 'me',
          mentions: { peerUserId: null, onOpen: vi.fn() },
          // J8: the tint follows the stored mentions; a group recipient is in them.
          mentionedMe: !mine,
        })}
      </p>,
    );
  }

  it('A3 recipient: "@all" bold with the mention-of-me tint, never a button', () => {
    const html = allMarkup(false);
    expect(html).toContain('@all');
    expect(html).not.toContain('@[');
    expect(html).not.toContain('<button');
    expect(html).toContain(mentionClass(false, true));
    expect(mentionClass(false, true)).toContain('font-bold');
    expect(mentionClass(false, true)).toContain('bg-accent-soft');
  });

  it('A3 sender: "@all" bold in own ink, no me tint', () => {
    const html = allMarkup(true);
    expect(html).toContain(mentionClass(true, false));
    expect(html).not.toContain('bg-accent-soft');
    expect(html).not.toContain('<button');
  });

  it('A3 list preview and draft line draw "@all" bold', () => {
    const html = renderStrip(<span>{boldAllMentions(draftLine('@[all] ship it', 'w1'))}</span>);
    expect(html).toContain('<span data-mention-all="" class="font-bold">@all</span> ship it');
    expect(boldAllMentions('no everyone here')).toBe('no everyone here');
  });

  it('A1 picker in a group shows the "@all" row first; a DM does not', () => {
    const members: MentionMember[] = [
      { userId: 'u1', displayName: 'Ana', avatarUrl: null, role: 'agency' },
    ];
    const group = renderStrip(
      <MentionPicker
        members={mentionPickerRows(members, '', null, true)}
        active={0}
        onPick={() => undefined}
      />,
    );
    expect(group).toContain('data-mention-option="all"');
    expect(group).toContain('@all');
    expect(group).toContain('Everyone in this group');
    expect(group.match(/min-h-\[44px\]/g)).toHaveLength(2);
    const dm = renderStrip(
      <MentionPicker
        members={mentionPickerRows(members, '', null, false)}
        active={0}
        onPick={() => undefined}
      />,
    );
    expect(dm).not.toContain('data-mention-option="all"');
    expect(dm).not.toContain('Everyone in this group');
  });
});

describe('J7 only a real "@[all]" token draws bold', () => {
  const nameOf = profileNameOf(new Map(), 'w1');
  const bubble = (body: string): string =>
    renderStrip(
      <p>
        {renderBodyWithMentions(body, false, {
          nameOf,
          viewerUserId: 'me',
          mentions: { peerUserId: null, onOpen: vi.fn() },
          mentionedMe: true,
        })}
      </p>,
    );
  const activity = (raw: string): string =>
    renderStrip(
      <ActivityCard
        group={[
          {
            id: 'e1',
            workspaceId: 'w1',
            number: null,
            eventType: 'mention',
            entityType: 'chat_channel',
            entityId: 'chan-1',
            scope: 'groups',
            tier: 'active',
            createdAt: '2026-06-14T00:00:00.000Z',
            readAt: null,
            snoozedUntil: null,
            commentId: null,
            assetId: null,
            toStage: null,
            fromStage: null,
            title: 'Launch crew',
            actorId: null,
            actorName: 'Bob',
            actorAvatarUrl: null,
            body: chatMentionPreview(raw, () => undefined),
            format: null,
            caption: null,
            thumbnailAssetVersionId: null,
            pointsAdded: null,
            checkpointTotal: null,
            batchId: null,
            messageId: null,
            channelType: 'group',
          },
        ]}
        nowMs={Date.parse('2026-06-14T00:05:00.000Z')}
        cache={cache}
        presignEnabled={false}
        onOpenGroup={() => {}}
        onOpenEntry={() => {}}
        onSnooze={() => {}}
        onMarkRead={() => {}}
        selfName={null}
      />,
    );
  const list = (raw: string): string =>
    renderStrip(<span>{boldAllMentions(previewMentionText(raw, 'w1'))}</span>);
  const draft = (raw: string): string =>
    renderStrip(<span>{boldAllMentions(draftLine(raw, 'w1'))}</span>);

  it('J7 plain "@all" not bold in list, draft line, Activity or bubble; the token is bold in all four', () => {
    const plain = '@all standup';
    const token = '@[all] standup';
    for (const html of [list(plain), draft(plain), activity(plain), bubble(plain)]) {
      expect(html).toContain('@all standup');
      expect(html).not.toContain('data-mention-all');
      expect(html).not.toContain('data-mention="all"');
      expect(html).not.toContain('font-bold">@all');
      expect(html).not.toContain(ALL_MARK);
    }
    for (const html of [list(token), draft(token), activity(token)]) {
      expect(html).toMatch(/<span data-mention-all="" class="font-bold[^"]*">@all<\/span>/);
      expect(html).not.toContain(ALL_MARK);
      expect(html).not.toContain('@[');
    }
    expect(bubble(token)).toContain(`data-mention="all" class="${mentionClass(false, true)}">@all`);
    expect(mentionClass(false, true)).toContain('font-bold');
  });
});

describe('J8 the mention-of-me tint follows the stored mentions', () => {
  const nameOf = profileNameOf(new Map(), 'w1');
  const render = (
    m: Pick<ThreadMessage, 'body' | 'mine' | 'mentions' | 'forwarded'>,
    isGroup: boolean,
  ): string =>
    renderStrip(
      <p>
        {renderBodyWithMentions(m.body, m.mine, {
          nameOf,
          viewerUserId: 'me',
          mentions: { peerUserId: null, onOpen: vi.fn() },
          mentionedMe: mentionsMe(m, 'me', isGroup),
        })}
      </p>,
    );

  it('J8 forwarded @[all]: bold, no tint; real @all in group for recipient: tint', () => {
    const forwarded = render(
      { body: '@[all] standup', mine: false, mentions: null, forwarded: true },
      true,
    );
    expect(forwarded).toContain(`class="${mentionClass(false, false)}">@all`);
    expect(forwarded).toContain('font-bold');
    expect(forwarded).not.toContain('bg-accent-soft');
    // A DM with a stray @[all]: the server stored no mention of me.
    const dm = render({ body: '@[all] hi', mine: false, mentions: [] }, false);
    expect(dm).toContain('font-bold');
    expect(dm).not.toContain('bg-accent-soft');
    // A live DM row (not read yet) predicts the same: no tint.
    expect(mentionsMe({ body: '@[all] hi', mine: false }, 'me', false)).toBe(false);
    // Real @all in a group: the server expanded it to me.
    const real = render({ body: '@[all] standup', mine: false, mentions: ['me', 'ana'] }, true);
    expect(real).toContain(`class="${mentionClass(false, true)}">@all`);
    expect(real).toContain('bg-accent-soft');
    // Stored mentions drive it even when the live prediction would differ.
    expect(mentionsMe({ body: 'no token', mine: false, mentions: ['me'] }, 'me', true)).toBe(true);
    expect(mentionsMe({ body: '@[all]', mine: false }, 'me', true)).toBe(true);
    expect(mentionsMe({ body: '@[all]', mine: true, mentions: ['me'] }, 'me', true)).toBe(false);
  });
});

describe('T12: the ring in light and dark, on own and peer bubbles and over a photo', () => {
  const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8');
  const block = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    return css.slice(at, css.indexOf('}', at));
  };
  const photo: MessageAttachment = {
    assetId: '',
    name: 'photo.png',
    mime: 'image/png',
    size: 3,
    local: {
      key: 'local-t12',
      file: new File(['abc'], 'photo.png', { type: 'image/png' }),
      previewUrl: 'blob:t12',
      progress: 0.6,
      uploading: true,
    },
  };
  const pdf: MessageAttachment = {
    assetId: '',
    name: 'brief.pdf',
    mime: 'application/pdf',
    size: 3,
    local: { key: 'local-t12f', file: null, previewUrl: null, progress: 0.6, uploading: true },
  };
  function ring(html: string): string {
    const at = html.indexOf('<button type="button" data-upload-ring');
    return html.slice(at, html.indexOf('</button>', at) + '</button>'.length);
  }
  function paint(attachments: MessageAttachment[], mine: boolean, theme: 'light' | 'dark') {
    return renderStrip(
      <div className={theme === 'dark' ? 'dark' : undefined}>
        <div className={mine ? OWN_BUBBLE_CONTENT : undefined}>
          <MessageAttachments
            attachments={attachments}
            cache={cache}
            presignEnabled
            album={attachments[0]?.mime === 'image/png'}
            onCancelUpload={() => {}}
          />
        </div>
      </div>,
    );
  }

  it.each([
    ['own bubble', [pdf], true],
    ['peer bubble', [pdf], false],
    ['over a photo', [photo], true],
  ] as const)('%s: same ring markup in light and dark (snapshot)', (_label, attachments, mine) => {
    const light = ring(paint([...attachments], mine, 'light'));
    const dark = ring(paint([...attachments], mine, 'dark'));
    expect(light).toBe(dark);
    expect(light).toMatchSnapshot();
  });

  it('draws only on overlay tokens that exist in both themes', () => {
    const html = ring(paint([pdf], false, 'light'));
    const tokens = [...html.matchAll(/(?:bg|text)-(overlay(?:-[a-z]+)?)\b/g)].map((m) => m[1]);
    expect(new Set(tokens)).toEqual(new Set(['overlay', 'overlay-fg', 'overlay-dot']));
    for (const token of tokens) {
      expect(block(':root')).toContain(`--${token}:`);
      expect(block('.dark')).toContain(`--${token}:`);
    }
    // No raw colour, no theme variant, no hard-coded white/black.
    expect(html).not.toMatch(new RegExp(['white', 'black', ['dark', ':'].join('')].join('|')));
  });

  it('the own-bubble restyle never reaches the ring (no translucent tile)', () => {
    const html = ring(paint([pdf], true, 'light'));
    const classes = new Set(
      [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/)),
    );
    const restyled = [...OWN_BUBBLE_CONTENT.matchAll(/\[&_\.([a-z0-9-]+)/g)].map((m) => m[1]);
    for (const name of restyled) expect(classes.has(name ?? '')).toBe(false);
    // The hover tint skips the ring's button.
    expect(OWN_BUBBLE_CONTENT).toContain('[&_button:not([data-upload-ring]):hover]');
    expect(OWN_BUBBLE_CONTENT).not.toContain('[&_button:hover]');
  });

  it('the tap target is at least 44x44 and reduced motion stops the pulse', () => {
    const html = ring(
      paint([{ ...pdf, local: { ...pdf.local!, uploading: false } }], false, 'light'),
    );
    expect(html).toContain('h-11 w-11');
    expect(html).toContain('animate-pulse motion-reduce:animate-none');
    expect(html).not.toContain('animate-spin');
  });
});

describe('the X on an own uploading bubble', () => {
  const uploading: MessageAttachment = {
    assetId: '',
    name: 'brief.pdf',
    mime: 'application/pdf',
    size: 3,
    local: { key: 'local-x', file: null, previewUrl: null, progress: 0.2, uploading: true },
  };
  function cancelOf(root: ReactElement): (() => void) | undefined {
    let found: (() => void) | undefined;
    walk(root, (el) => {
      if (el.type === MessageAttachments) {
        found = (el.props as { onCancelUpload?: () => void }).onCancelUpload;
      }
    });
    return found;
  }

  it('an own sending bubble hands the cancel (with its id) to its attachments', () => {
    const onCancelUpload = vi.fn();
    const root = renderBubble(
      makeMessage({
        id: 'up-1',
        mine: true,
        senderUserId: 'me',
        body: 'caption',
        state: 'sending',
        attachments: [uploading],
      }),
      { onCancelUpload },
    );
    cancelOf(root)?.();
    expect(onCancelUpload).toHaveBeenCalledWith('up-1');
  });

  it.each([
    ['sent', { state: 'sent' as const, mine: true }],
    ['failed', { state: 'failed' as const, mine: true }],
    ['files missing', { state: 'failed' as const, mine: true, filesMissing: true }],
    ['a peer message', { state: 'sent' as const, mine: false }],
  ])('%s: no cancel offered', (_label, over) => {
    const root = renderBubble(makeMessage({ ...over, attachments: [uploading] }), {
      onCancelUpload: vi.fn(),
    });
    expect(cancelOf(root)).toBeUndefined();
  });
});

describe('decision 128: every Reply focuses the composer inside the user event', () => {
  /** A composer input fake: logs focus and caret calls in order. */
  function fakeInput(value: string) {
    const log: string[] = [];
    const input = {
      value,
      focus: vi.fn((options?: FocusOptions) => {
        log.push(`focus:${options?.preventScroll === true ? 'noscroll' : 'scroll'}`);
      }),
      setSelectionRange: vi.fn((start: number, end: number) => {
        log.push(`caret:${start}-${end}`);
      }),
    };
    return { input, log };
  }
  const msg = makeMessage({ id: 'm-reply', body: 'quote me' });

  /** Run fn with every deferral (timers, frames, microtasks) frozen: only sync calls count. */
  function synchronously(fn: () => void): void {
    vi.useFakeTimers({ toFake: ['setTimeout', 'requestAnimationFrame', 'queueMicrotask'] });
    try {
      fn();
    } finally {
      vi.useRealTimers();
    }
  }

  it('replyWithFocus focuses (no scroll, caret at the draft end) before the reply is set', () => {
    const { input, log } = fakeInput('half a draft');
    const reply = replyWithFocus(
      () => input,
      (m: ThreadMessage) => log.push(`reply:${m.id}`),
    );
    synchronously(() => reply(msg));
    expect(log).toEqual(['focus:noscroll', 'caret:12-12', 'reply:m-reply']);
    expect(input.value).toBe('half a draft');
  });

  it('long-press / chevron / right-click menu Reply: focus runs in the row tap, before the menu closes', () => {
    const { input, log } = fakeInput('');
    const onReply = replyWithFocus(
      () => input,
      (m: ThreadMessage) => log.push(`reply:${m.id}`),
    );
    const items = messageMenuItems({
      canCopy: true,
      onReply: () => onReply(msg),
      onCopy: () => {},
    });
    const item = items.find((i) => i.key === 'reply');
    expect(item).toBeDefined();
    if (item === undefined) return;
    synchronously(() =>
      runMenuItem(item, { openMark: () => log.push('mark'), close: () => log.push('close') }),
    );
    expect(log).toEqual(['focus:noscroll', 'caret:0-0', 'reply:m-reply', 'close']);
  });

  it('swipe right: focus runs inside the pointerup that releases the swipe', () => {
    const { input, log } = fakeInput('keep');
    const onReply = replyWithFocus(
      () => input,
      (m: ThreadMessage) => log.push(`reply:${m.id}`),
    );
    const swipe = createSwipeReplyController({
      onReply: () => onReply(msg),
      onFrame: () => {},
      vibrate: () => {},
      raf: () => 0,
      cancelRaf: () => {},
      now: () => 0,
    });
    const at = (x: number, t: number) => ({
      clientX: 100 + x,
      clientY: 200,
      pointerType: 'touch',
      pointerId: 1,
      timeStamp: t,
    });
    swipe.handlers.onPointerDown(at(0, 0));
    swipe.handlers.onPointerMove(at(40, 50));
    swipe.handlers.onPointerMove(at(90, 100));
    expect(input.focus).not.toHaveBeenCalled();
    synchronously(() => swipe.handlers.onPointerUp({ timeStamp: 110 }));
    expect(log).toEqual(['focus:noscroll', 'caret:4-4', 'reply:m-reply']);
  });

  it('card hold Talk about: focus waits for the release (never the hold timer), once', () => {
    const { input, log } = fakeInput('');
    const focus = (): void => focusComposerInput(input);
    const talk = createTalkAboutHold();
    talk.held();
    expect(input.focus).not.toHaveBeenCalled();
    synchronously(() => talk.release(focus));
    expect(log).toEqual(['focus:noscroll', 'caret:0-0']);
    talk.release(focus);
    expect(input.focus).toHaveBeenCalledTimes(1);
    // A plain tap (no hold) never focuses; a cancelled hold forgets itself.
    talk.release(focus);
    talk.held();
    talk.reset();
    talk.release(focus);
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it('F1 laptop or mouse card hold: focus as the hold fires; release, leave, cancel add nothing', () => {
    expect(holdFocusesOnFire({ layout: 'laptop', pointerType: 'mouse' })).toBe(true);
    expect(holdFocusesOnFire({ layout: 'laptop', pointerType: 'touch' })).toBe(true);
    expect(holdFocusesOnFire({ layout: 'touch', pointerType: 'mouse' })).toBe(true);
    expect(holdFocusesOnFire({ layout: 'touch', pointerType: 'touch' })).toBe(false);
    expect(holdFocusesOnFire({ layout: 'touch', pointerType: 'pen' })).toBe(false);
    const { input, log } = fakeInput('kept draft');
    const focus = (): void => focusComposerInput(input);
    const talk = createTalkAboutHold();
    synchronously(() => talk.held(focus));
    expect(log).toEqual(['focus:noscroll', 'caret:10-10']);
    expect(input.value).toBe('kept draft');
    // The mouse drifted off the card: leave resets, release and cancel add nothing.
    talk.reset();
    talk.release(focus);
    talk.release(focus);
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it('F2 touch card hold: no focus at the hold, once on pointerup; none after a cancel', () => {
    const { input } = fakeInput('');
    const focus = (): void => focusComposerInput(input);
    const talk = createTalkAboutHold();
    talk.held(undefined);
    expect(input.focus).not.toHaveBeenCalled();
    talk.release(focus);
    expect(input.focus).toHaveBeenCalledTimes(1);
    talk.held(undefined);
    talk.reset();
    talk.release(focus);
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it('sheet Talk about: the post comes in, then focus, both inside the tap', () => {
    const { input, log } = fakeInput('');
    const tap = talkAboutThenFocus(
      () => log.push('about'),
      () => focusComposerInput(input),
    );
    synchronously(tap);
    expect(log).toEqual(['about', 'focus:noscroll', 'caret:0-0']);
  });

  it('a card in selection mode gets no Talk about focus', () => {
    const refs = { onTalkAbout: () => {}, onTalkAboutFocus: () => {} };
    expect(
      cardRefsFor('m1', { role: 'selectable', checked: false, onToggle: () => {} }, refs)
        .onTalkAboutFocus,
    ).toBeUndefined();
    expect(cardRefsFor('m1', undefined, refs).onTalkAboutFocus).toBe(refs.onTalkAboutFocus);
  });

  it('no composer mounted: Reply still sets the reply and never throws', () => {
    const set = vi.fn();
    replyWithFocus(() => null, set)(msg);
    expect(set).toHaveBeenCalledWith(msg);
  });
});
