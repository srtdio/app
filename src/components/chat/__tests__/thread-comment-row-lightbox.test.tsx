// @vitest-environment jsdom
// Regression (18 Nov 2026): a photo in a post, brief, Plan or Bank comment (and
// in their threads, all drawn by ThreadCommentRow) opens chat's image viewer at
// that photo; it was inert after comments moved onto chat's row. The viewer
// swipes through the comment's photos and Escape closes it.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));

import { ThreadCommentRow } from '@/components/chat/ThreadCommentRow';
import { commentMessage, localCommentRow } from '@/components/comments/Comments';
import type { ChatProfile } from '@/lib/chat-reads';
import type { ThreadMessage } from '@/lib/chat/thread';
import type { ReactionsApi } from '@/lib/reactions/use-reactions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ME = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const PROFILES: Map<string, ChatProfile> = new Map([
  [ANA, { userId: ANA, displayName: 'Ana', avatarUrl: null }],
]);
const NO_REACTIONS: ReactionsApi = {
  of: () => [],
  rowsOf: () => [],
  toggle: () => undefined,
  pick: () => undefined,
  me: ME,
};

function withFiles(files: ThreadMessage['attachments']): ThreadMessage {
  const row = localCommentRow({
    id: 'c1',
    workspaceId: 'w1',
    entityType: 'post',
    entityId: 'p1',
    authorUserId: ANA,
    body: 'Two crops to compare',
    attachmentVersionIds: [],
    parentCommentId: null,
    nowIso: new Date().toISOString(),
  });
  return { ...commentMessage(row, ME, new Map()), attachments: files };
}

const PHOTOS: ThreadMessage['attachments'] = [
  { assetId: 'a1', name: 'crop-1.jpg', mime: 'image/jpeg' },
  { assetId: 'a2', name: 'crop-2.jpg', mime: 'image/jpeg' },
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(message: ThreadMessage): HTMLDivElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      <MemoryRouter>
        <ThreadCommentRow
          message={message}
          head
          tail
          afterLabel={false}
          profiles={PROFILES}
          workspaceId="w1"
          me={ME}
          layout="touch"
          highlighted={false}
          hoverMenu={false}
          coarsePointer
          reducedMotion
          personSource={() => null}
          mentions={{ peerUserId: null, onOpen: () => undefined }}
          onOpenMenu={() => undefined}
          onReply={() => undefined}
          onTapOpen={() => undefined}
          onRetry={undefined}
          onDiscard={undefined}
          reactions={NO_REACTIONS}
        />
      </MemoryRouter>,
    );
  });
  return host;
}

const viewer = (): Element | null => document.querySelector('[aria-label="Image viewer"]');

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('comment photos open the image viewer', () => {
  it('a tap on the second photo opens the viewer at it, "2 / 2"', () => {
    const el = mount(withFiles(PHOTOS));
    expect(viewer()).toBeNull();
    const tiles = el.querySelectorAll<HTMLButtonElement>('[data-album] button[aria-label]');
    expect(tiles.length).toBe(2);
    act(() => tiles[1]?.click());
    expect(viewer()).not.toBeNull();
    expect(document.querySelector('[data-lightbox-counter]')?.textContent).toBe('2 / 2');
  });

  it('the viewer portals over the app, outside the row', () => {
    const el = mount(withFiles(PHOTOS));
    act(() => el.querySelector<HTMLButtonElement>('[data-album] button[aria-label]')?.click());
    expect(viewer()).not.toBeNull();
    expect(el.contains(viewer())).toBe(false);
  });

  it('Escape closes the viewer', () => {
    const el = mount(withFiles(PHOTOS));
    act(() => el.querySelector<HTMLButtonElement>('[data-album] button[aria-label]')?.click());
    expect(viewer()).not.toBeNull();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(viewer()).toBeNull();
  });
});
