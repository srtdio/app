import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// MessageThread's import graph pulls the message factory, which imports the real
// agora-chat browser SDK (mirrors MessageThread.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import {
  BubbleMetaView,
  MessageBubble,
  bubbleClass,
  isCardOnly,
  lastCardKind,
} from '@/components/chat/MessageThread';
import { SharedPostCards } from '@/components/chat/PostCard';
import { SharedBriefCards } from '@/components/chat/BriefCard';
import { SharedPlanCards } from '@/components/chat/PlanCard';
import { SharedIdeaCards } from '@/components/chat/PlanItemCard';
import { PresignCache } from '@/lib/asset-presign';
import type { ThreadMessage } from '@/lib/chat/thread';

// Guard (B1, ui/ChatCard): the card IS the bubble. A card-only message draws
// no wrapper bubble around its card (no fill, padding or light on the shell;
// the shell keeps only the press, menu and reactions), its time and tick sit
// inside its last card, and no chat card file draws a card frame of its own.

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

function message(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'peer-1',
    body: '',
    createdAt: '2026-09-22T18:45:00.123456+00:00',
    time: Date.parse('2026-09-22T18:45:00.123456+00:00'),
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

function walk(node: ReactNode, visit: (el: ReactElement) => void): void {
  if (Array.isArray(node)) {
    node.forEach((child) => walk(child, visit));
    return;
  }
  if (!isValidElement(node)) return;
  visit(node);
  walk((node.props as { children?: ReactNode }).children, visit);
}

function bubble(m: ThreadMessage): ReactElement {
  return MessageBubble({
    message: m,
    profiles: new Map(),
    cache,
    presignEnabled: false,
    showTicks: true,
    isGroup: false,
    head: true,
    tail: true,
    timeZone: 'UTC',
    layout: 'touch',
  });
}

const CARD_PARTS = [SharedPostCards, SharedBriefCards, SharedPlanCards, SharedIdeaCards];

function parts(root: ReactElement): {
  shell: ReactElement<{ className?: string }> | null;
  cards: Array<ReactElement<{ inBubble?: boolean; cardMeta?: ReactNode }>>;
  rowMeta: number;
} {
  let shell: ReactElement<{ className?: string }> | null = null;
  const cards: Array<ReactElement<{ inBubble?: boolean; cardMeta?: ReactNode }>> = [];
  let rowMeta = 0;
  walk(root, (el) => {
    const props = el.props as Record<string, unknown>;
    if (props['data-bubble'] === '') shell = el as ReactElement<{ className?: string }>;
    if ((CARD_PARTS as unknown[]).includes(el.type)) {
      cards.push(el as ReactElement<{ inBubble?: boolean; cardMeta?: ReactNode }>);
    }
    if (el.type === BubbleMetaView) rowMeta += 1;
  });
  return { shell, cards, rowMeta };
}

/** A bubble fill, padding or light: what a wrapper bubble would draw. */
const WRAPPER = /(^| )(bg-|lit-bubble|px-|py-|p-\[|pb-|pt-|pl-|pr-)/;

describe('chat cards: the card is the bubble (no wrapper bubble)', () => {
  const kinds: Array<[string, Partial<ThreadMessage>]> = [
    ['post', { sharedPostIds: ['p1'] }],
    ['brief', { sharedBriefIds: ['b1'] }],
    ['plan', { sharedPlanIds: ['plan1'] }],
    ['idea', { sharedPlanItemIds: ['i1'] }],
  ];

  for (const [kind, over] of kinds) {
    for (const mine of [false, true]) {
      it(`a card-only ${kind} message (${mine ? 'own' : 'peer'}): bare shell, card holds the time`, () => {
        const m = message({ ...over, mine });
        expect(isCardOnly(m, { chip: false })).toBe(true);
        const { shell, cards, rowMeta } = parts(bubble(m));
        // The shell keeps the bubble's behaviour, never its look.
        expect(shell).not.toBeNull();
        const cls = String(shell!.props.className);
        expect(cls).not.toMatch(WRAPPER);
        expect(cls).toContain('focus-visible:lit-focus');
        // No meta row in the shell. L1: a head's time sits on its name line,
        // so the card's time slot stays empty.
        expect(rowMeta).toBe(0);
        expect(cards.every((c) => c.props.cardMeta === undefined)).toBe(true);
        for (const card of cards) expect(card.props.inBubble).toBe(false);
      });
    }
  }

  it('a card with text: the cards sit inside the message, no bubble fill (L1)', () => {
    const m = message({ body: 'Have a look', sharedPostIds: ['p1'] });
    expect(isCardOnly(m, { chip: false })).toBe(false);
    const { shell, cards, rowMeta } = parts(bubble(m));
    expect(String(shell!.props.className)).not.toContain('bg-panel-2');
    expect(rowMeta).toBe(0);
    for (const card of cards) expect(card.props.inBubble).toBe(true);
  });

  it('a quote, Forwarded line, mark or post chip keeps the bubble', () => {
    const base = { sharedPostIds: ['p1'] };
    expect(
      isCardOnly(message({ ...base, reply: { id: 'm0', authorUserId: null, preview: 'x' } }), {
        chip: false,
      }),
    ).toBe(false);
    expect(isCardOnly(message({ ...base, forwarded: true }), { chip: false })).toBe(false);
    expect(isCardOnly(message(base), { chip: true })).toBe(false);
    expect(isCardOnly(message({}), { chip: false })).toBe(false);
  });

  it('the time goes in the last kind the bubble draws', () => {
    expect(lastCardKind(message({ sharedPostIds: ['p'], sharedBriefIds: ['b'] }))).toBe('brief');
    expect(lastCardKind(message({ sharedPlanIds: ['p'], sharedPlanItemIds: ['i'] }))).toBe('idea');
    expect(lastCardKind(message({}))).toBeNull();
  });

  it('bubbleClass for a card: radius and focus only (no fill, padding, light or tail)', () => {
    for (const layout of ['touch', 'laptop'] as const) {
      for (const mine of [false, true]) {
        const cls = bubbleClass({
          mine,
          head: true,
          tail: true,
          layout,
          failed: false,
          voiceOnly: false,
          card: true,
        });
        expect(cls).not.toMatch(WRAPPER);
        expect(cls).not.toContain('rounded-br-[4px]');
        expect(cls).not.toContain('rounded-bl-[4px]');
        expect(cls).not.toContain('rounded-tr-none');
      }
    }
  });

  it('source: no chat card file hand-builds a card frame or wraps ChatCard', () => {
    for (const file of [
      'components/chat/PlanCard.tsx',
      'components/chat/PostCard.tsx',
      'components/chat/PlanItemCard.tsx',
      'components/chat/BriefCard.tsx',
    ]) {
      const src = read(file);
      expect(src, file).toContain('<ChatCard');
      // The old frames: a 12px bordered panel card around the card's rows.
      expect(src, file).not.toMatch(/rounded-xl border[^'"`]*bg-panel/);
      expect(src, file).not.toMatch(/w-\[2(40|84)px\]/);
    }
    const thread =
      read('components/chat/MessageThread.tsx') + read('components/chat/MessageBubble.tsx');
    expect(thread).toContain('card: cardOnly');
    expect(thread).toContain('voiceOnly || cardOnly || metaEmpty ? null');
    expect(thread).not.toContain('OWN_BUBBLE_CONTENT');
  });
});
