import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// The cards' import graph pulls the message factory, which imports the real
// agora-chat browser SDK (mirrors PlanCard.test.tsx).
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));

import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import type { PostCardRow } from '../../packages/posts/src/reads';
import { ChatCardOwn, OWN_CARD_INK } from '@/components/ui/ChatCard';
import { MessageBubble } from '@/components/chat/MessageThread';
import {
  NotVisibleCard,
  PostCardSkeleton,
  PostCouldntLoadCard,
  SharedPostCardList,
  SharedPostCards,
} from '@/components/chat/PostCard';
import { indexPostsById, sharedPostViews } from '@/components/chat/post-card';
import { BriefCardItem, SharedBriefCards } from '@/components/chat/BriefCard';
import { PlanCardBody, PlanCardSkeleton, SharedPlanCards } from '@/components/chat/PlanCard';
import {
  IdeaCardSkeleton,
  PlanItemCardBody,
  SharedIdeaCards,
} from '@/components/chat/PlanItemCard';
import { PresignCache } from '@/lib/asset-presign';
import type { PlanBundle } from '@/lib/chat/plans';
import type { ThreadMessage } from '@/lib/chat/thread';

// Guard (B1b-1 fix): in an own message every ui/ChatCard (plan, post, idea,
// brief, and their loading / failed states) is the own bubble: bg-bubble-own,
// accent-fg ink, lit-bubble-own, and its child ink (title, tag, meta, action
// labels, time) reads on that fill; never a light peer surface (bg-panel-2,
// lit-bubble-other) with white text over it. A peer message keeps the peer
// fill. The card is the bubble: no wrapper bubble around it.

const POST: PostCardRow = {
  id: 'p1',
  number: 12,
  title: 'Monday carousel',
  platform: 'instagram',
  format: 'single_image',
  stage: 'review',
  target_date: '2026-10-02',
  stage_entered_at: '2026-09-20T10:00:00Z',
  approved_by: null,
  approved_at: null,
  thumbnailAssetVersionId: null,
  firstMedia: null,
  mediaCount: 0,
  hasVideo: false,
};

const BUNDLE: PlanBundle = {
  plan: {
    id: 'plan1',
    workspace_id: 'ws',
    title: 'Week of 12 Oct',
    starts_on: '2026-10-12',
    ends_on: '2026-10-18',
    audience: 'client',
    created_by: null,
  },
  items: [],
  reviews: [],
  postStages: {},
  postInfo: {},
};

const noop = (): void => undefined;

const KINDS: Array<[string, ReactElement]> = [
  [
    'post',
    <SharedPostCardList
      key="post"
      views={sharedPostViews(['p1'], indexPostsById([POST]), new Map())}
      side="client"
      timeZone="UTC"
      workspaceZone="UTC"
      cardMeta="2:14 PM"
      inBubble={false}
    />,
  ],
  ['post skeleton', <PostCardSkeleton key="ps" platform="instagram" cardMeta="2:14 PM" />],
  ['post not visible', <NotVisibleCard key="pn" platform="instagram" cardMeta="2:14 PM" />],
  [
    'post couldnt load',
    <PostCouldntLoadCard key="pf" platform="instagram" onRetry={noop} cardMeta="2:14 PM" />,
  ],
  [
    'plan',
    <PlanCardBody
      key="plan"
      view={{ kind: 'plan', bundle: BUNDLE }}
      side="agency"
      onOpen={noop}
      onForward={noop}
      cardMeta="2:14 PM"
    />,
  ],
  ['plan skeleton', <PlanCardSkeleton key="pls" cardMeta="2:14 PM" />],
  [
    'idea',
    <PlanItemCardBody
      key="idea"
      view={{
        kind: 'idea',
        id: 'i1',
        title: 'Behind the scenes reel',
        planId: null,
        planTitle: null,
        day: null,
        archived: false,
        showToClient: false,
        starred: false,
        comments: 2,
      }}
      onOpen={noop}
      cardMeta="2:14 PM"
    />,
  ],
  ['idea skeleton', <IdeaCardSkeleton key="is" cardMeta="2:14 PM" />],
  [
    'brief',
    <BriefCardItem
      key="brief"
      view={{ kind: 'brief', briefId: 'b1', title: 'Diwali launch', status: 'open' }}
      cardMeta="2:14 PM"
    />,
  ],
];

function render(card: ReactElement, own: boolean): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <ChatCardOwn value={own}>{card}</ChatCardOwn>
    </MemoryRouter>,
  );
}

/** Markup escapes & in attributes; class lists compare unescaped. */
const unamp = (cls: string): string => cls.replace(/&amp;/g, '&');

/** The class list of each [data-chat-card] root in the markup. */
function cardRoots(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<div[^>]*data-chat-card=""[^>]*>/g)) {
    const cls = /class="([^"]*)"/.exec(m[0]);
    out.push(unamp(cls?.[1] ?? ''));
  }
  return out;
}

function classes(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((m) => unamp(m[1]!).split(/\s+/));
}

describe('own chat cards keep the own-bubble ink', () => {
  for (const [kind, card] of KINDS) {
    it(`own ${kind}: the own-bubble fill, never a light peer surface`, () => {
      const html = render(card, true);
      const roots = cardRoots(html);
      expect(roots.length).toBeGreaterThan(0);
      for (const cls of roots) {
        const list = cls.split(/\s+/);
        expect(list).toContain('bg-bubble-own');
        expect(list).toContain('text-accent-fg');
        expect(list).toContain('lit-bubble-own');
        expect(list).not.toContain('bg-panel-2');
        expect(list).not.toContain('lit-bubble-other');
        // The child ink map rides on the root.
        for (const part of OWN_CARD_INK.split(/\s+/)) expect(list).toContain(part);
      }
      expect(html).toContain('data-chat-card-own=""');
      // No descendant paints the peer bubble's light layer.
      expect(html).not.toContain('lit-bubble-other');
      // Any panel fill or grey ink under the card is remapped to the on-bubble
      // ink by the root (never a light panel with white text over it).
      const root = roots[0]!;
      const all = classes(html);
      for (const token of ['bg-panel', 'bg-panel-2', 'bg-panel-3']) {
        if (all.includes(token)) expect(root).toContain(`[&_.${token}]:bg-on-bubble/[.12]`);
      }
      for (const token of ['text-fg', 'text-fg-2', 'text-fg-3', 'text-accent']) {
        if (all.includes(token)) expect(root).toContain(`[&_.${token}]:text-accent-fg`);
      }
    });

    it(`peer ${kind}: the peer bubble fill`, () => {
      const html = render(card, false);
      for (const cls of cardRoots(html)) {
        const list = cls.split(/\s+/);
        expect(list).toContain('bg-panel-2');
        expect(list).toContain('lit-bubble-other');
        expect(list).not.toContain('bg-bubble-own');
        expect(cls).not.toContain('[&_.text-fg-2]:text-accent-fg');
      }
      expect(html).not.toContain('data-chat-card-own');
    });
  }
});

// Contrast on the own surface: the title and meta ink (accent-fg, the
// on-bubble ink) over bubble-own, and over the on-bubble/12 inner fill, clear
// 4.5:1 in light and dark.
const css = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8');

function token(selector: ':root' | '.dark', name: string): [number, number, number] {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const hex = new RegExp(`--${name}:\\s*#([0-9a-fA-F]{6})`).exec(body)?.[1];
  if (hex === undefined) throw new Error(`no ${name} in ${selector}`);
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
}

function lum([r, g, b]: [number, number, number]): number {
  const c = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
}

function contrastOnOwn(fg: [number, number, number], bg: [number, number, number]): number {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
}

function mix(
  top: [number, number, number],
  alpha: number,
  under: [number, number, number],
): [number, number, number] {
  return top.map((v, i) => Math.round(v * alpha + under[i]! * (1 - alpha))) as [
    number,
    number,
    number,
  ];
}

describe('own card ink contrast', () => {
  for (const theme of [':root', '.dark'] as const) {
    it(`${theme}: title and meta ink on the own fill and its inner fill >= 4.5:1`, () => {
      const ink = token(theme, 'accent-fg');
      const meta = token(theme, 'bubble-meta-own');
      const fill = token(theme, 'bubble-own');
      const onBubble = token(theme, 'on-bubble');
      const inner = mix(onBubble, 0.12, fill);
      expect(contrastOnOwn(ink, fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrastOnOwn(meta, fill)).toBeGreaterThanOrEqual(4.5);
      expect(contrastOnOwn(ink, inner)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

// The thread hands every card its side, and an own card-only message draws no
// wrapper bubble: the cards sit under ChatCardOwn(value = mine).
const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});

function message(over: Partial<ThreadMessage>): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'me',
    body: '',
    createdAt: '2026-09-22T18:45:00.123456+00:00',
    time: Date.parse('2026-09-22T18:45:00.123456+00:00'),
    provisionalTime: false,
    mine: true,
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

const CARD_PARTS: unknown[] = [SharedPostCards, SharedBriefCards, SharedPlanCards, SharedIdeaCards];

function cardsUnderOwn(root: ReactElement): { under: number; outside: number; values: boolean[] } {
  let under = 0;
  let outside = 0;
  const values: boolean[] = [];
  const visit = (node: ReactNode, own: boolean | null): void => {
    if (Array.isArray(node)) {
      node.forEach((child) => visit(child, own));
      return;
    }
    if (!isValidElement(node)) return;
    let next = own;
    if (node.type === ChatCardOwn) {
      next = (node.props as { value: boolean }).value;
      values.push(next);
    }
    if (CARD_PARTS.includes(node.type)) {
      if (next === null) outside += 1;
      else under += 1;
    }
    visit((node.props as { children?: ReactNode }).children, next);
  };
  visit(root, null);
  return { under, outside, values };
}

describe('the thread hands each card its side', () => {
  const kinds: Array<[string, Partial<ThreadMessage>]> = [
    ['post', { sharedPostIds: ['p1'] }],
    ['brief', { sharedBriefIds: ['b1'] }],
    ['plan', { sharedPlanIds: ['plan1'] }],
    ['idea', { sharedPlanItemIds: ['i1'] }],
  ];
  for (const [kind, over] of kinds) {
    for (const mine of [true, false]) {
      for (const body of ['', 'Ready for your look']) {
        // L1 (8 Nov 2026): no own fill, so every card sits under ChatCardOwn(false).
        it(`${mine ? 'own' : 'peer'} ${kind}${body !== '' ? ' with text' : ''}: cards under ChatCardOwn(false)`, () => {
          const tree = MessageBubble({
            message: message({ ...over, mine, body }),
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
          const { under, outside, values } = cardsUnderOwn(tree);
          expect(under).toBeGreaterThan(0);
          expect(outside).toBe(0);
          expect(values.every((v) => v === false)).toBe(true);
        });
      }
    }
  }
});
