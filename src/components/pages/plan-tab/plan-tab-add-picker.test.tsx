// @vitest-environment jsdom
// F6: the Plan tab's add-posts picker adds only on Done. Dismissing it (X,
// backdrop, swipe, Escape, Back: the picker's onClose) drops the ticks and
// adds nothing; Done (onDone) adds the ticked posts on the picked day.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCardFields } from '@srtdio/posts';
import type { PlanBundle } from '@/lib/chat/plans';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface PickerProps {
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  onToggle: (post: PostCardFields) => void;
}

const h = vi.hoisted(() => ({
  planPostsAdd: vi.fn(),
  picker: null as PickerProps | null,
  menu: null as { onPickPost: () => void } | null,
}));

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@srtdio/rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@srtdio/rpc')>()),
  planPostsAdd: (...args: unknown[]) => h.planPostsAdd(...args),
  planConceptAdd: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ show: () => {} }) }));
vi.mock('@/lib/chat/use-chat-attachments', () => ({
  useCommentAttachments: () => ({ canAttach: false, uploadFile: undefined }),
}));
vi.mock('@/components/chat/PlanAddSheet', () => ({
  PlanAddSheet: (p: { onPickPost: () => void }) => {
    h.menu = p;
    return null;
  },
}));
vi.mock('@/components/chat/ConceptSheet', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/ConceptSheet')>()),
  ConceptSheet: () => null,
}));
vi.mock('@/components/chat/PostPicker', () => ({
  PostPicker: (p: PickerProps) => {
    h.picker = p;
    return null;
  },
}));

import { PlanTabAdd } from './PlanTabAdd';

const BUNDLE = {
  plan: { id: 'plan-1', starts_on: '2026-11-01', ends_on: '2026-11-30' },
  items: [],
  reviews: [],
  postStages: {},
  postInfo: {},
} as unknown as PlanBundle;

const POST = { id: 'post-1', title: 'Post 1' } as unknown as PostCardFields;

let root: Root | null = null;
let onClose = vi.fn();

async function openPickerWithOneTick(): Promise<PickerProps> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <PlanTabAdd
        target={{ bundle: BUNDLE, day: '2026-11-12' }}
        timeZone="UTC"
        onClose={onClose}
      />,
    );
  });
  await act(async () => h.menu?.onPickPost());
  await act(async () => h.picker?.onToggle(POST));
  const picker = h.picker;
  if (picker === null || !picker.open) throw new Error('picker not open');
  return picker;
}

beforeEach(() => {
  h.planPostsAdd.mockReset();
  h.planPostsAdd.mockResolvedValue({ ok: true, data: null });
  h.picker = null;
  h.menu = null;
  onClose = vi.fn();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('Plan tab add-posts picker (F6)', () => {
  it('dismissing the picker adds nothing and closes it', async () => {
    const picker = await openPickerWithOneTick();
    await act(async () => picker.onClose());
    expect(h.planPostsAdd).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(h.picker?.open).toBe(false);
  });

  it('Done adds the ticked posts on the picked day', async () => {
    const picker = await openPickerWithOneTick();
    expect(picker.onDone).toBeTypeOf('function');
    await act(async () => picker.onDone?.());
    expect(h.planPostsAdd).toHaveBeenCalledTimes(1);
    const args = h.planPostsAdd.mock.calls[0]?.[1] as {
      p_plan_id: string;
      p_post_ids: string[];
      p_target_date: string;
    };
    expect(args.p_plan_id).toBe('plan-1');
    expect(args.p_post_ids).toEqual(['post-1']);
    expect(args.p_target_date).toBe('2026-11-12');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
