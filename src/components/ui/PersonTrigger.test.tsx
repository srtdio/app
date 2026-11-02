// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonTrigger, openPersonCardFrom } from '@/components/ui/PersonTrigger';
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
    expect(personCardSnapshot()).toEqual({ userId: LEO, name: 'Leo', anchor: null, trigger: null });
  });
});
