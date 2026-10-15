// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostPlatform } from '@srtdio/posts';
import type { PostSheetPreset } from '@/lib/induction';

const { mockWorkspace, mockPostCreate, mockGallerySet, mockStage, mockShare, newTrace } =
  vi.hoisted(() => ({
    mockWorkspace: { workspacePlatform: 'instagram' as PostPlatform },
    mockPostCreate: vi.fn(),
    mockGallerySet: vi.fn(),
    mockStage: vi.fn(),
    mockShare: vi.fn(),
    newTrace: () => 'trace-1',
  }));

vi.mock('@/lib/workspace-context-platform', () => ({
  useWorkspacePlatform: (id: string | null) =>
    id === 'ws-1' ? mockWorkspace.workspacePlatform : null,
}));
vi.mock('@/lib/session-context', () => ({ useSession: () => ({ session: null }) }));
vi.mock('@/lib/trace-context', () => ({ useNewTrace: () => newTrace }));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/buckets', () => ({ listBuckets: async () => ({ ok: true, data: [] }) }));
vi.mock('@srtdio/briefs', () => ({ listBriefs: async () => ({ ok: true, data: [] }) }));
vi.mock('@/components/pages/pcs/use-post-members', () => ({
  usePostMembers: () => ({ options: [] }),
}));
vi.mock('@/components/pages/create/AttachmentsField', () => ({
  AttachmentsField: () => null,
  attachmentVersionIds: (items: { versionId: string }[]) => items.map((i) => i.versionId),
}));
vi.mock('@/components/ui/DatePicker', () => ({ DatePicker: () => null }));
vi.mock('@srtdio/rpc', () => ({
  postCreate: mockPostCreate,
  gallerySet: mockGallerySet,
  stageTransition: mockStage,
}));
vi.mock('@/lib/chat/share-post', () => ({ sharePostToChannel: mockShare }));
// The media field's upload path has its own tests: here it hands back one upload.
vi.mock('@/components/induction/PresetMediaField', () => ({
  PresetMediaField: (props: {
    required: boolean;
    onChange: (items: { versionId: string; kind: 'image'; name: string }[]) => void;
  }) => (
    <button
      type="button"
      data-required={props.required ? 'yes' : 'no'}
      onClick={() => props.onChange([{ versionId: 'v-1', kind: 'image', name: 'hero.png' }])}
    >
      Fake upload
    </button>
  ),
}));

import {
  CreatePostSheet,
  REVIEW_RETRY_MESSAGE,
  presetCanSubmit,
  presetPrimaryLabel,
} from '@/components/pages/CreatePostSheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const onCreated = vi.fn();

const SEND: PostSheetPreset = {
  primary: 'send_for_review',
  share: { channelId: 'group__ws-1__g1', groupName: 'Kite' },
};

beforeEach(() => {
  for (const m of [mockPostCreate, mockGallerySet, mockStage, mockShare, onCreated]) m.mockReset();
  mockPostCreate.mockResolvedValue({ ok: true, data: 'post-1' });
  mockGallerySet.mockResolvedValue({ ok: true, data: 'g' });
  mockStage.mockResolvedValue({ ok: true, data: null });
  mockShare.mockResolvedValue({ ok: true });
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

async function renderSheet(platform: PostPlatform, preset: PostSheetPreset): Promise<void> {
  mockWorkspace.workspacePlatform = platform;
  root = createRoot(host!);
  await act(async () => {
    root!.render(
      <CreatePostSheet
        open
        workspaceId="ws-1"
        preset={preset}
        onClose={() => {}}
        onCreated={onCreated}
      />,
    );
  });
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
  if (found === undefined) throw new Error(`no button ${text}`);
  return found;
}

async function typeCaption(value: string): Promise<void> {
  const el = document.querySelector<HTMLTextAreaElement>('#post-caption')!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('CreatePostSheet preset', () => {
  it('hides owner, bucket, origin, brief and the title field', async () => {
    await renderSheet('instagram', SEND);
    for (const label of ['Owner', 'Bucket', 'Origin', 'Brief']) {
      expect(document.querySelector(`button[aria-label="${label}"]`)).toBeNull();
    }
    expect(document.querySelector('#post-title')).toBeNull();
    expect(document.body.textContent).toContain('Target date (optional)');
  });

  it('requires media for a reel, then sends for review with the title from the caption', async () => {
    await renderSheet('instagram', SEND);
    await typeCaption('Diwali drop\nMore words');
    const primary = button('Send for review');
    expect(primary.getAttribute('data-induction')).toBe('post-sheet-primary');
    expect(primary.disabled).toBe(true);
    await act(async () => button('Fake upload').click());
    expect(primary.disabled).toBe(false);
    await act(async () => primary.click());

    const args = mockPostCreate.mock.calls[0]![1] as { p_payload: Record<string, unknown> };
    expect(args.p_payload).toMatchObject({ title: 'Diwali drop', format: 'reel' });
    expect('owner_user_id' in args.p_payload).toBe(false);
    expect(mockGallerySet.mock.calls[0]![1]).toMatchObject({ p_asset_version_ids: ['v-1'] });
    expect(mockStage.mock.calls[0]![1]).toMatchObject({
      p_post_id: 'post-1',
      p_to_stage: 'review',
    });
    expect(mockShare.mock.calls[0]![1]).toEqual({ channelId: 'group__ws-1__g1', postId: 'post-1' });
    expect(onCreated).toHaveBeenCalledWith('post-1');
  });

  it('needs no media for a text post on X', async () => {
    await renderSheet('x', SEND);
    await typeCaption('Thread opener');
    expect(button('Send for review').disabled).toBe(false);
  });

  it('retries the move to review without creating the post again', async () => {
    mockStage.mockResolvedValueOnce({ ok: false, error: { code: 'unknown', message: 'x' } });
    await renderSheet('x', SEND);
    await typeCaption('Thread opener');
    await act(async () => button('Send for review').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(REVIEW_RETRY_MESSAGE);
    expect(onCreated).not.toHaveBeenCalled();
    // Nothing typed is lost.
    expect(document.querySelector<HTMLTextAreaElement>('#post-caption')!.value).toBe(
      'Thread opener',
    );

    await act(async () => button('Send for review again').click());
    expect(mockPostCreate).toHaveBeenCalledTimes(1);
    expect(mockStage).toHaveBeenCalledTimes(2);
    expect(onCreated).toHaveBeenCalledWith('post-1');
  });

  it('saves a teammate post as a draft, never moving it', async () => {
    await renderSheet('x', { primary: 'save_draft', share: 'no_group' });
    await typeCaption('Working title');
    await act(async () => button('Save as draft').click());
    expect(mockStage).not.toHaveBeenCalled();
    expect(mockShare).not.toHaveBeenCalled();
    expect(onCreated).toHaveBeenCalledWith('post-1');
  });

  it('says so when there is no group, and leaves the share toggle out', async () => {
    await renderSheet('x', { primary: 'send_for_review', share: 'no_group' });
    expect(document.querySelector('[role="switch"]')).toBeNull();
    expect(document.body.textContent).toContain('no chat group yet');
  });

  it('shares in the group by default, and not once switched off', async () => {
    await renderSheet('x', SEND);
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(toggle.getAttribute('aria-label')).toBe('Share in the Kite chat');
    await act(async () => toggle.click());
    await typeCaption('Thread opener');
    await act(async () => button('Send for review').click());
    expect(mockShare).not.toHaveBeenCalled();
  });
});

describe('preset helpers', () => {
  it('labels the primary by preset', () => {
    expect(presetPrimaryLabel({ preset: SEND, submitting: false, savedDraft: false })).toBe(
      'Send for review',
    );
    expect(presetPrimaryLabel({ preset: SEND, submitting: false, savedDraft: true })).toBe(
      'Send for review again',
    );
    expect(
      presetPrimaryLabel({
        preset: { primary: 'save_draft', share: 'no_group' },
        submitting: false,
        savedDraft: false,
      }),
    ).toBe('Save as draft');
  });

  it('needs a caption, and media when the format needs it', () => {
    const base = { caption: 'Hi', format: 'reel', attachments: 0, busy: false };
    expect(presetCanSubmit(base)).toBe(false);
    expect(presetCanSubmit({ ...base, attachments: 1 })).toBe(true);
    expect(presetCanSubmit({ ...base, format: 'text' })).toBe(true);
    expect(presetCanSubmit({ ...base, format: 'text', caption: ' ' })).toBe(false);
    expect(presetCanSubmit({ ...base, attachments: 1, busy: true })).toBe(false);
  });
});
