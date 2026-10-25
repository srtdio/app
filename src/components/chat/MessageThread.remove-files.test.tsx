// Remove files, keep the message: the in-bubble line where the files were
// ("1 photo removed"), never on a tombstone; the removal behind the Undo strip
// (the overlay drops the files at once, Undo brings them back); a refused
// record brings back what it refused and toasts its copy.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
// File bubbles render the shared post, brief and plan cards, which read the
// workspace and session providers; these messages share none, so the cards
// render nothing here.
vi.mock('@/components/chat/PostCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/PostCard')>()),
  SharedPostCards: () => null,
}));
vi.mock('@/components/chat/BriefCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/BriefCard')>()),
  SharedBriefCards: () => null,
}));
vi.mock('@/components/chat/PlanCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/PlanCard')>()),
  SharedPlanCards: () => null,
}));

import { MessageBubble, removeFilesAction } from '@/components/chat/MessageThread';
import { FilesRemovedLine } from '@/components/chat/MessageAttachments';
import { PresignCache } from '@/lib/asset-presign';
import type { ChatProfile } from '@/lib/chat-reads';
import {
  applyRemovedOverlay,
  createRemovedFilesStore,
  REMOVE_REFUSED_TOAST,
  type RemovableFile,
} from '@/lib/chat/remove-files';
import type { ThreadMessage } from '@/lib/chat/thread';

const cache = new PresignCache({
  endpoint: null,
  getAccessToken: () => Promise.resolve(null),
  fetcher: () => Promise.reject(new Error('unused')),
});
const PROFILES: Map<string, ChatProfile> = new Map([
  ['peer-1', { userId: 'peer-1', displayName: 'Alice', avatarUrl: null }],
]);
const AT = '2026-10-25T10:00:00Z';

function msg(over: Partial<ThreadMessage> = {}): ThreadMessage {
  return {
    id: 'm1',
    senderUserId: 'me',
    body: 'the brief',
    createdAt: AT,
    time: Date.parse(AT),
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

function bubble(message: ThreadMessage): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <MessageBubble
        message={message}
        profiles={PROFILES}
        cache={cache}
        presignEnabled={false}
        showTicks={false}
        isGroup={false}
        head
        tail
        timeZone="UTC"
        layout="touch"
        onBadgeClick={() => {}}
      />
    </MemoryRouter>,
  );
}

const LINE = 'data-testid="files-removed-line"';

describe('the removed line in the bubble', () => {
  it('reads the label with the ban icon, in the bubble meta ink, italic', () => {
    const own = renderToStaticMarkup(
      <FilesRemovedLine counts={{ photo: 1, video: 0, file: 0 }} mine layout="touch" />,
    );
    expect(own).toContain(LINE);
    expect(own).toContain('1 photo removed');
    expect(own).toContain('italic');
    expect(own).toContain('--bubble-meta-own');
    const peer = renderToStaticMarkup(
      <FilesRemovedLine counts={{ photo: 0, video: 0, file: 1 }} mine={false} layout="laptop" />,
    );
    expect(peer).toContain('File removed');
    expect(peer).toContain('--bubble-meta)');
  });

  it('nothing removed: no line', () => {
    expect(
      renderToStaticMarkup(
        <FilesRemovedLine counts={{ photo: 0, video: 0, file: 0 }} mine layout="touch" />,
      ),
    ).toBe('');
  });

  it('a message left with text only is a text bubble with the line above its text', () => {
    const html = bubble(msg({ removedFiles: { photo: 2, video: 0, file: 0 } }));
    expect(html).toContain(LINE);
    expect(html).toContain('2 photos removed');
    expect(html).toContain('the brief');
    expect(html.indexOf(LINE)).toBeLessThan(html.indexOf('data-msg-body'));
  });

  it('a file message keeps the line at the files spot, after its text', () => {
    const html = bubble(
      msg({
        attachments: [{ assetId: 'a2', name: 'notes.pdf', mime: 'application/pdf' }],
        removedFiles: { photo: 0, video: 0, file: 1 },
      }),
    );
    expect(html).toContain('File removed');
    expect(html.indexOf('data-msg-body')).toBeLessThan(html.indexOf(LINE));
  });

  it('never on a tombstone', () => {
    const html = bubble(msg({ deleted: true, removedFiles: { photo: 1, video: 0, file: 0 } }));
    expect(html).toContain('data-tombstone');
    expect(html).not.toContain(LINE);
    expect(html).not.toContain('removed');
  });

  it('no removal: no line', () => {
    expect(bubble(msg())).not.toContain(LINE);
  });
});

const PHOTO: RemovableFile = { messageId: 'm1', assetId: 'a1', mime: 'image/jpeg' };
const DOC: RemovableFile = { messageId: 'm1', assetId: 'a2', mime: 'application/pdf' };

function withFiles(): ThreadMessage[] {
  return [
    msg({
      attachments: [
        { assetId: 'a1', name: '1.jpg', mime: 'image/jpeg' },
        { assetId: 'a2', name: 'notes.pdf', mime: 'application/pdf' },
      ],
    }),
  ];
}

describe('removeFilesAction: the Undo strip', () => {
  it('the files go at once; the strip reads their label; no confirm', () => {
    const store = createRemovedFilesStore();
    const action = removeFilesAction({
      store,
      channelId: 'c1',
      files: [PHOTO],
      remove: () => Promise.resolve({ ok: true, removed: [PHOTO] }),
      showToast: vi.fn(),
    });
    expect(action.label).toBe('1 photo removed');
    const shown = applyRemovedOverlay(withFiles(), store.get('c1'));
    expect(shown[0]?.attachments.map((a) => a.assetId)).toEqual(['a2']);
    expect(shown[0]?.removedFiles).toEqual({ photo: 1, video: 0, file: 0 });
  });

  it('Undo restores the overlay (the files come back)', () => {
    const store = createRemovedFilesStore();
    const action = removeFilesAction({
      store,
      channelId: 'c1',
      files: [PHOTO, DOC],
      remove: vi.fn(),
      showToast: vi.fn(),
    });
    expect(action.label).toBe('1 photo and 1 file removed');
    action.revert?.();
    expect(store.get('c1').pending.size).toBe(0);
    const shown = applyRemovedOverlay(withFiles(), store.get('c1'));
    expect(shown[0]?.attachments).toHaveLength(2);
    expect(shown[0]?.removedFiles).toBeUndefined();
  });

  it('a refused record brings the files back and toasts the ownership copy', async () => {
    const store = createRemovedFilesStore();
    const showToast = vi.fn();
    const action = removeFilesAction({
      store,
      channelId: 'c1',
      files: [PHOTO],
      remove: () =>
        Promise.resolve({
          ok: false,
          removed: [],
          message: REMOVE_REFUSED_TOAST,
          error: 'only your own files can be removed',
        }),
      showToast,
    });
    await action.commit();
    expect(showToast).toHaveBeenCalledWith("Couldn't remove. Only your own files can be removed.");
    expect(store.get('c1').pending.size).toBe(0);
  });

  it('a part-accepted record keeps the accepted files removed', async () => {
    const store = createRemovedFilesStore();
    const action = removeFilesAction({
      store,
      channelId: 'c1',
      files: [PHOTO, DOC],
      remove: () =>
        Promise.resolve({
          ok: false,
          removed: [PHOTO],
          message: "Couldn't remove. Try again.",
          error: 'boom',
        }),
      showToast: vi.fn(),
    });
    await action.commit();
    const shown = applyRemovedOverlay(withFiles(), store.get('c1'));
    expect(shown[0]?.attachments.map((a) => a.assetId)).toEqual(['a2']);
  });
});

describe('MessageThread wiring (source)', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./MessageThread.tsx', import.meta.url)),
    'utf8',
  );
  it('the wrapper applies the overlay and re-reads live removals', () => {
    expect(source).toContain('removedFilesStore.subscribe');
    expect(source).toContain('subscribeFilesRemoved(liveClient');
    expect(source).toContain('rereadRemovedRows(supabase');
  });
  it('the removal runs behind useUndoableAction, with no ConfirmDialog', () => {
    expect(source).toContain('undoable.run(action);');
  });
  it('the info sheets get onRemoveFiles', () => {
    expect(source).toContain('{...(onRemoveFiles !== undefined ? { onRemoveFiles } : {})}');
    expect(source).toContain('...(onRemoveFiles !== undefined ? { onRemoveFiles } : {}),');
  });
});
