// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PersonTrigger,
  openPersonCardFrom,
  openPersonPhotoFrom,
} from '@/components/ui/PersonTrigger';
import type { PrivateReplyDraft } from '@/lib/chat/private-reply';
import { closePersonCard, personCardSnapshot } from '@/lib/person-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LEO = '0190a000-0000-7000-8000-000000000003';
const BOX = { top: 10, left: 20, right: 60, bottom: 30 };

let root: Root | null = null;

interface Mounted {
  trigger: HTMLElement;
  parentClick: ReturnType<typeof vi.fn>;
  parentPointer: ReturnType<typeof vi.fn>;
  parentKey: ReturnType<typeof vi.fn>;
}

async function mount(
  props: {
    name?: string | null;
    avatarUrl?: string | null;
    username?: string | null;
    former?: boolean;
  } = {
    name: 'Leo Martins',
    avatarUrl: 'https://x.test/leo.png',
    username: 'leo',
  },
): Promise<Mounted> {
  const parentClick = vi.fn();
  const parentPointer = vi.fn();
  const parentKey = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      // A row around the trigger (e.g. a PressableRow): its own tap must not fire.
      <div data-row="" onClick={parentClick} onPointerDown={parentPointer} onKeyDown={parentKey}>
        <PersonTrigger userId={LEO} {...props}>
          <span>Leo</span>
        </PersonTrigger>
      </div>,
    );
  });
  const trigger = document.querySelector<HTMLElement>(`[data-person-trigger="${LEO}"]`);
  if (trigger === null) throw new Error('no trigger');
  trigger.getBoundingClientRect = () =>
    ({ ...BOX, x: BOX.left, y: BOX.top, width: 40, height: 20, toJSON: () => BOX }) as DOMRect;
  return { trigger, parentClick, parentPointer, parentKey };
}

async function press(trigger: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

afterEach(() => {
  act(() => closePersonCard());
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PersonTrigger', () => {
  it('is a focusable role=button labelled with the name', async () => {
    const { trigger } = await mount();
    expect(trigger.getAttribute('role')).toBe('button');
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute('aria-label')).toBe('Leo Martins');
  });

  it('has no aria-label when the name is not known', async () => {
    const { trigger } = await mount({ name: null });
    expect(trigger.hasAttribute('aria-label')).toBe(false);
  });

  it('a click opens the card with the hint, the anchor box and the trigger', async () => {
    const { trigger } = await mount();
    await act(async () => trigger.click());
    expect(personCardSnapshot()).toEqual({
      userId: LEO,
      name: 'Leo Martins',
      avatarUrl: 'https://x.test/leo.png',
      username: 'leo',
      anchor: BOX,
      trigger,
      view: 'card',
    });
  });

  it('passes former through to the card', async () => {
    const { trigger } = await mount({ name: 'Ola', former: true });
    await act(async () => trigger.click());
    expect(personCardSnapshot()?.former).toBe(true);
  });

  it('stops the click: the row around it does not get it', async () => {
    const { trigger, parentClick } = await mount();
    await act(async () => trigger.click());
    expect(personCardSnapshot()).not.toBeNull();
    expect(parentClick).not.toHaveBeenCalled();
  });

  it('stops pointerdown: the row press state and long-press never start', async () => {
    const { trigger, parentPointer } = await mount();
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(parentPointer).not.toHaveBeenCalled();
  });

  it('Enter opens the card', async () => {
    const { trigger, parentKey } = await mount();
    await press(trigger, 'Enter');
    expect(personCardSnapshot()?.userId).toBe(LEO);
    expect(personCardSnapshot()?.trigger).toBe(trigger);
    expect(parentKey).not.toHaveBeenCalled();
  });

  it('Space opens the card', async () => {
    const { trigger } = await mount();
    await press(trigger, ' ');
    expect(personCardSnapshot()?.userId).toBe(LEO);
  });

  it('other keys do nothing', async () => {
    const { trigger } = await mount();
    await press(trigger, 'a');
    expect(personCardSnapshot()).toBeNull();
  });
});

describe('openPersonCardFrom', () => {
  it('a null element opens with no anchor and no trigger', () => {
    openPersonCardFrom(null, { userId: LEO, name: 'Leo' });
    expect(personCardSnapshot()).toEqual({
      userId: LEO,
      name: 'Leo',
      anchor: null,
      trigger: null,
      view: 'card',
    });
  });

  it('openPersonPhotoFrom opens the photo-only viewer', () => {
    openPersonPhotoFrom(null, { userId: LEO, name: 'Leo' });
    expect(personCardSnapshot()?.view).toBe('photo');
    expect(personCardSnapshot()?.userId).toBe(LEO);
  });
});

const SOURCE: PrivateReplyDraft = {
  kind: 'comment',
  sourceId: 'c-1',
  authorUserId: LEO,
  authorName: 'Leo Martins',
  excerpt: 'Can the cover use the morning shot?',
  whereLabel: 'Monday carousel',
  link: { kind: 'comment', entityType: 'post', entityId: 'p-1', commentId: 'c-1' },
};

async function mountWith(
  view: 'card' | 'photo' | undefined,
  source?: () => PrivateReplyDraft | null,
): Promise<HTMLElement> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <PersonTrigger
        userId={LEO}
        name="Leo Martins"
        {...(view !== undefined ? { view } : {})}
        {...(source !== undefined ? { source } : {})}
      >
        <span>Leo</span>
      </PersonTrigger>,
    );
  });
  const trigger = document.querySelector<HTMLElement>(`[data-person-trigger="${LEO}"]`);
  if (trigger === null) throw new Error('no trigger');
  return trigger;
}

describe('PersonTrigger view and source', () => {
  it('defaults to the card and marks it on the element', async () => {
    const trigger = await mountWith(undefined);
    expect(trigger.getAttribute('data-person-view')).toBe('card');
    await act(async () => trigger.click());
    expect(personCardSnapshot()?.view).toBe('card');
    expect(personCardSnapshot()?.source).toBeUndefined();
  });

  it('the card carries the source built at tap time', async () => {
    const source = vi.fn(() => SOURCE);
    const trigger = await mountWith('card', source);
    expect(source).not.toHaveBeenCalled();
    await act(async () => trigger.click());
    expect(source).toHaveBeenCalledTimes(1);
    expect(personCardSnapshot()?.source).toEqual(SOURCE);
  });

  it('a null source opens the card with none (no context line)', async () => {
    const trigger = await mountWith('card', () => null);
    await act(async () => trigger.click());
    expect(personCardSnapshot()?.view).toBe('card');
    expect(personCardSnapshot()?.source).toBeUndefined();
  });

  it("view 'photo' opens the photo viewer and never builds a source", async () => {
    const source = vi.fn(() => SOURCE);
    const trigger = await mountWith('photo', source);
    expect(trigger.getAttribute('data-person-view')).toBe('photo');
    await act(async () => trigger.click());
    expect(personCardSnapshot()?.view).toBe('photo');
    expect(personCardSnapshot()?.source).toBeUndefined();
    expect(source).not.toHaveBeenCalled();
  });
});
