// @vitest-environment jsdom
// Inside a DM a person opens the photo only: the DM header's photo is a
// PersonTrigger with view 'photo' (the name still opens Contact info). A group
// header and Personal notes have no photo trigger (Group info / notes).

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));
vi.mock('@/lib/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { ThreadHeaderIdentity } from '@/components/chat/MessageThread';
import { closePersonCard, personCardSnapshot } from '@/lib/person-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRIYA = '0190a000-0000-7000-8000-000000000002';

let root: Root | null = null;

async function mount(props: {
  isGroup: boolean;
  notes?: boolean;
  photoUserId?: string | null;
  onOpenContact: () => void;
}): Promise<void> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <ThreadHeaderIdentity
        isGroup={props.isGroup}
        title="Priya Shah"
        avatarUrl={null}
        presence={undefined}
        headerLine={null}
        layout="touch"
        onOpenContact={props.onOpenContact}
        {...(props.notes !== undefined ? { notes: props.notes } : {})}
        {...(props.photoUserId !== undefined ? { photoUserId: props.photoUserId } : {})}
      />,
    );
  });
}

afterEach(() => {
  act(() => closePersonCard());
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('DM header photo opens the photo viewer', () => {
  it('the DM photo is a photo-view trigger; a tap opens the viewer, not Contact info', async () => {
    const onOpenContact = vi.fn();
    await mount({ isGroup: false, photoUserId: PRIYA, onOpenContact });
    const trigger = document.querySelector<HTMLElement>(`[data-person-trigger="${PRIYA}"]`);
    expect(trigger?.getAttribute('data-person-view')).toBe('photo');
    await act(async () => trigger?.click());
    expect(personCardSnapshot()?.view).toBe('photo');
    expect(personCardSnapshot()?.userId).toBe(PRIYA);
    expect(onOpenContact).not.toHaveBeenCalled();
  });

  it('the name still opens Contact info', async () => {
    const onOpenContact = vi.fn();
    await mount({ isGroup: false, photoUserId: PRIYA, onOpenContact });
    await act(async () => {
      document.querySelector<HTMLElement>('[data-contact-open]')?.click();
    });
    expect(onOpenContact).toHaveBeenCalledTimes(1);
    expect(personCardSnapshot()).toBeNull();
  });

  it('a group header has no photo trigger', async () => {
    await mount({ isGroup: true, photoUserId: PRIYA, onOpenContact: vi.fn() });
    expect(document.querySelector('[data-person-trigger]')).toBeNull();
  });

  it('Personal notes have no photo trigger', async () => {
    await mount({ isGroup: false, notes: true, photoUserId: PRIYA, onOpenContact: vi.fn() });
    expect(document.querySelector('[data-person-trigger]')).toBeNull();
  });

  it('a DM without a known peer keeps the plain photo', async () => {
    await mount({ isGroup: false, photoUserId: null, onOpenContact: vi.fn() });
    expect(document.querySelector('[data-person-trigger]')).toBeNull();
  });
});
