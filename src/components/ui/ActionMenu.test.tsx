// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionMenu, orderActionItems } from '@/components/ui/ActionMenu';
import type { ActionMenuItem } from '@/components/ui/ActionMenu';
import { ICON_SIZE, IconArrowUpRight, IconEdit, IconLink, IconTrash } from '@/components/ui/icons';
import { DUR_BASE_MS } from '@/lib/motion';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The phone/laptop split is the one hook; the test flips it per case.
const laptop = vi.hoisted(() => ({ value: false }));
vi.mock('@/lib/use-is-laptop', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/use-is-laptop')>()),
  useIsLaptop: () => laptop.value,
}));

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function items(onSelect = vi.fn()): ActionMenuItem[] {
  // Passed deliberately out of order: Delete first, Open third.
  return [
    { id: 'delete', label: 'Delete post', icon: IconTrash, tone: 'danger', onSelect },
    { id: 'rename', label: 'Rename', icon: IconEdit, description: 'Change the title', onSelect },
    { id: 'open', label: 'Open post', icon: IconArrowUpRight, onSelect },
    { id: 'copy-link', label: 'Copy link', icon: IconLink, onSelect },
  ];
}

async function mount(rows: ActionMenuItem[] = items()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<ActionMenu title="Post actions" items={rows} />);
    await wait(10);
  });
  return host;
}

async function openMenu(): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
  if (trigger === null) throw new Error('no trigger');
  await act(async () => {
    trigger.click();
    await wait(30);
  });
}

const menuRows = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((row) => row);
const rowLabels = () =>
  menuRows().map((row) => row.querySelector('span.truncate')?.textContent ?? row.textContent);

beforeEach(() => {
  laptop.value = false;
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('orderActionItems', () => {
  it('puts Open first, Copy link second, Delete last, others in caller order', () => {
    expect(orderActionItems(items()).map((item) => item.id)).toEqual([
      'open',
      'copy-link',
      'rename',
      'delete',
    ]);
  });

  it('ranks by label too: "Open ..." first and "Delete ..." last', () => {
    const noop = () => {};
    const ordered = orderActionItems([
      { id: 'remove', label: 'Delete forever', icon: IconTrash, onSelect: noop },
      { id: 'a', label: 'Archive', icon: IconEdit, onSelect: noop },
      { id: 'view', label: 'Open in new tab', icon: IconArrowUpRight, onSelect: noop },
      { id: 'b', label: 'Bookmark', icon: IconEdit, onSelect: noop },
    ]);
    expect(ordered.map((item) => item.id)).toEqual(['view', 'a', 'b', 'remove']);
  });

  it('does not mutate the input', () => {
    const input = items();
    const before = input.map((item) => item.id);
    orderActionItems(input);
    expect(input.map((item) => item.id)).toEqual(before);
  });
});

describe('ActionMenu trigger', () => {
  it('defaults to an IconButton labelled "More actions"', async () => {
    await mount();
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('renders no opener when trigger is null', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(<ActionMenu title="Post actions" items={items()} trigger={null} />);
      await wait(10);
    });
    expect(document.querySelector('[aria-label="More actions"]')).toBeNull();
  });
});

describe('ActionMenu on phone', () => {
  it('opens a Sheet (dialog) titled {title}', async () => {
    await mount();
    await openMenu();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-label')).toBe('Post actions');
    expect(dialog?.querySelector('h2')?.textContent).toBe('Post actions');
  });

  it('lists rows in menu order with Delete last', async () => {
    await mount();
    await openMenu();
    expect(rowLabels()).toEqual(['Open post', 'Copy link', 'Rename', 'Delete post']);
  });

  it('shows descriptions', async () => {
    await mount();
    await openMenu();
    expect(document.body.textContent).toContain('Change the title');
  });

  it('gives the danger row text-bad and the others text-fg', async () => {
    await mount();
    await openMenu();
    const rows = menuRows();
    const del = rows[rows.length - 1];
    expect(del?.className).toContain('text-bad');
    expect(rows[0]?.className).not.toContain('text-bad');
    expect(rows[0]?.className).toContain('text-fg');
  });

  it('renders row icons at the tray size', async () => {
    await mount();
    await openMenu();
    for (const row of menuRows()) {
      expect(row.querySelector('svg')?.getAttribute('width')).toBe(String(ICON_SIZE.tray));
    }
  });

  it('closes and runs onSelect when a row is chosen', async () => {
    const onSelect = vi.fn();
    await mount([{ id: 'rename', label: 'Rename', icon: IconEdit, onSelect }]);
    await openMenu();
    await act(async () => {
      menuRows()[0]?.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    // The close renders when the first act ends; the Sheet then stays mounted
    // through its exit transition (DUR_BASE_MS) before it unmounts.
    await act(async () => {
      await wait(DUR_BASE_MS + 50);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('ActionMenu on laptop', () => {
  beforeEach(() => {
    laptop.value = true;
  });

  it('opens a popover menu, not a dialog', async () => {
    await mount();
    await openMenu();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[aria-label="Post actions"]')).not.toBeNull();
  });

  it('lists rows in the same order with Delete last', async () => {
    await mount();
    await openMenu();
    expect(rowLabels()).toEqual(['Open post', 'Copy link', 'Rename', 'Delete post']);
  });

  it('leaves descriptions out', async () => {
    await mount();
    await openMenu();
    expect(document.body.textContent).not.toContain('Change the title');
  });

  it('gives the danger row text-bad', async () => {
    await mount();
    await openMenu();
    const rows = menuRows();
    expect(rows[rows.length - 1]?.className).toContain('text-bad');
    expect(rows[0]?.className).not.toContain('text-bad');
  });

  it('renders row icons at the tray size', async () => {
    await mount();
    await openMenu();
    for (const row of menuRows()) {
      expect(row.querySelector('svg')?.getAttribute('width')).toBe(String(ICON_SIZE.tray));
    }
  });

  it('closes on Escape and hands focus back to the trigger', async () => {
    await mount();
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
    trigger?.focus();
    await openMenu();
    await act(async () => {
      menuRows()[0]?.focus();
    });
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(DUR_BASE_MS + 50);
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger);
  });

  it('marks the trigger expanded while open', async () => {
    await mount();
    await openMenu();
    const trigger = document.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  });
});
