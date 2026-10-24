import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The chat store's import graph pulls the browser agora-chat SDK; never in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
// Every Supabase read goes through this spy: rendering notes avatars reads nothing.
const { from, rpc } = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { from, rpc } }));

import { notesAvatarView, NOTES_AVATAR_LABEL } from '@/components/chat/NotesBits';
import { notesSummary } from '@/lib/chat/notes';
import { notesTile } from '@/components/chat/ChannelList';
import { ThreadHeaderIdentity, threadHeaderLine } from '@/components/chat/MessageThread';
import { forwardRowAvatar } from '@/components/chat/ForwardPicker';
import { searchResultsView } from '@/components/chat/SearchResults';
import { IDLE_SEARCH } from '@/lib/chat/search';

const WS = '0190a000-0000-7000-8000-00000000a001';
const ME = '0190a000-0000-7000-8000-000000000001';
const PHOTO = 'https://cdn.test/me.png';

const view = (over: Partial<Parameters<typeof notesAvatarView>[0]> = {}): string =>
  renderToStaticMarkup(
    notesAvatarView({
      size: 'tile',
      src: PHOTO,
      loaded: true,
      failed: false,
      surface: 'panel',
      ...over,
    }),
  );

describe('notes avatar', () => {
  it('own photo + notebook badge once the photo is loaded', () => {
    const html = view();
    expect(html).toContain('data-notes-avatar="photo"');
    expect(html).toContain(`src="${PHOTO}"`);
    expect(html).toContain('object-cover');
    expect(html).toContain('data-notes-badge');
    expect(html).toMatch(
      /data-notes-badge=""[^>]*aria-hidden="true"|aria-hidden="true"[^>]*data-notes-badge/,
    );
    expect(html).toContain(`aria-label="${NOTES_AVATAR_LABEL}"`);
    // Tile badge: 30px, -5px out, 3px ring in the surface token.
    expect(html).toContain('h-[30px] w-[30px] -bottom-[5px] -right-[5px] border-[3px]');
    expect(html).toContain('border-panel');
    expect(html).toContain('bg-accent text-accent-fg');
  });

  it('the badge ring follows the row hover fill when asked', () => {
    expect(view({ hoverSurface: 'panel-2' })).toContain('group-hover/notes-row:border-panel-2');
    expect(view()).not.toContain('group-hover/notes-row');
  });

  it('small sizes: 44px radius 12, 20px badge, -4px out, 2px ring', () => {
    const html = view({ size: 'small', surface: 'bg' });
    expect(html).toContain('h-11 w-11 rounded-xl');
    expect(html).toContain('h-5 w-5 -bottom-1 -right-1 border-2');
    expect(html).toContain('border-bg');
  });

  it('no photo: notebook square, no badge, no image', () => {
    const html = view({ src: null, loaded: false });
    expect(html).toContain('data-notes-avatar="notebook"');
    expect(html).toContain('bg-accent-soft text-accent');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data-notes-badge');
  });

  it('photo failed to load: notebook, no badge, no broken image, never initials', () => {
    const html = view({ failed: true, loaded: false });
    expect(html).toContain('data-notes-avatar="notebook"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('data-notes-badge');
    expect(html).not.toMatch(/>[A-Z]{1,2}</);
  });

  it('still loading: notebook shows, the photo waits invisible in the same box (no shift)', () => {
    const html = view({ loaded: false });
    expect(html).toContain('data-notes-avatar="notebook"');
    expect(html).toContain('opacity-0');
    expect(html).toContain('absolute inset-0');
    expect(html).not.toContain('data-notes-badge');
    expect(html.match(/h-\[76px\] w-\[76px\]/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('the same notes avatar in all four places, no reads', () => {
  const notes = notesSummary(WS, ME, PHOTO);

  it('tile, header, forward picker and search rows render it from the summary', () => {
    const tile = renderToStaticMarkup(
      notesTile({ notes, selected: false, selecting: false, onSelect: () => {} }),
    );
    const header = renderToStaticMarkup(
      <ThreadHeaderIdentity
        isGroup={false}
        notes
        title={notes.title}
        avatarUrl={notes.avatarUrl}
        presence={undefined}
        headerLine={threadHeaderLine({
          notes: true,
          isGroup: false,
          peerTyping: true,
          role: 'admin',
          workspaceName: 'Studio',
        })}
        layout="touch"
      />,
    );
    const picker = renderToStaticMarkup(forwardRowAvatar(notes, false));
    const search = renderToStaticMarkup(
      searchResultsView({
        query: 'shoot',
        chats: [],
        state: {
          ...IDLE_SEARCH,
          query: 'shoot',
          status: 'ready',
          hits: [
            {
              id: 'h1',
              channelId: notes.channelId,
              senderUserId: ME,
              body: 'shoot list',
              createdAt: '2026-10-03T10:00:00Z',
            },
          ],
        },
        channelsById: new Map([[notes.channelId, notes]]),
        currentUserId: ME,
        nameOf: () => undefined,
        nowMs: Date.parse('2026-10-03T12:00:00Z'),
        timeZone: 'UTC',
        onOpenChat: () => {},
        onOpenHit: () => {},
        onRetry: () => {},
      }),
    );
    for (const html of [tile, header, picker, search]) {
      expect(html).toContain('data-notes-avatar');
      expect(html).toContain(`src="${PHOTO}"`);
    }
    expect(tile).toContain('h-[76px] w-[76px] rounded-[18px]');
    expect(header).toContain('h-10 w-10 rounded-xl');
    expect(picker).toContain('h-11 w-11 rounded-xl');
    expect(search).toContain('h-11 w-11 rounded-xl');
    expect(from).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it('carries the photo from app state onto the summary, null without one', () => {
    expect(notesSummary(WS, ME, PHOTO).avatarUrl).toBe(PHOTO);
    expect(notesSummary(WS, ME).avatarUrl).toBeNull();
  });
});

describe('header second line', () => {
  it('notes: "Only you can see this", never role, typing or online', () => {
    expect(
      threadHeaderLine({
        notes: true,
        isGroup: false,
        peerTyping: true,
        role: 'admin',
        workspaceName: 'Studio',
      }),
    ).toBe('Only you can see this');
  });

  it('DM and group lines are unchanged', () => {
    const dm = { isGroup: false, peerTyping: false, role: null, workspaceName: 'Studio' };
    expect(threadHeaderLine({ ...dm, notes: false })).toBe('Studio');
    expect(threadHeaderLine({ ...dm, notes: false, peerTyping: true })).toBe('typing…');
    expect(threadHeaderLine({ ...dm, notes: false, isGroup: true })).toBeNull();
  });
});
