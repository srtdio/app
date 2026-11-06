// @vitest-environment jsdom
// The Filter and sort sheet's bucket chips: add (Enter adds through the
// writes and picks it; Esc cancels), rename in place, delete behind the Undo
// strip (the real delete only when the strip ends; Undo brings it back).
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BucketOption } from '@/lib/buckets';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface UndoAction {
  label: string;
  commit: () => Promise<void> | void;
  revert?: () => void;
}

const h = vi.hoisted(() => ({
  laptop: true,
  toasts: [] as string[],
  undo: [] as UndoAction[],
  menus: new Map<string, { open: boolean; items: Array<{ id: string; onSelect: () => void }> }>(),
}));

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/use-is-laptop', () => ({ useIsLaptop: () => h.laptop }));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ show: (t: { title: string }) => h.toasts.push(t.title), dismiss: () => {} }),
}));
vi.mock('@/lib/use-undoable-action', () => ({
  useUndoableAction: () => ({ run: (a: UndoAction) => h.undo.push(a), flush: () => {} }),
}));
vi.mock('@/components/ui/ActionMenu', () => ({
  ActionMenu: (p: {
    title: string;
    open?: boolean;
    items: Array<{ id: string; onSelect: () => void }>;
  }) => {
    h.menus.set(p.title, { open: p.open === true, items: p.items });
    return null;
  },
}));

import { BucketChips, type BucketWrites } from './BankFilterSheet';

const PRODUCT: BucketOption = { id: 'b1', name: 'Product', colorHex: '#000000', position: 0 };

let root: Root;
let host: HTMLDivElement;
let buckets: BucketOption[];
let picked: string | null;
let writes: BucketWrites & {
  create: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function render(): void {
  act(() =>
    root.render(
      <BucketChips
        buckets={buckets}
        picked={picked}
        onPick={(id) => {
          picked = id;
          render();
        }}
        writes={writes}
        onBuckets={(next) => {
          buckets = next;
          render();
        }}
      />,
    ),
  );
}

function input(): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>('[data-bank-bucket-input]');
  if (el === null) throw new Error('no input');
  return el;
}

function type(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function key(el: HTMLInputElement, k: string): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  buckets = [PRODUCT];
  picked = null;
  h.toasts = [];
  h.undo = [];
  h.menus.clear();
  h.laptop = true;
  writes = {
    create: vi.fn(async (name: string) => ({
      ok: true as const,
      bucket: { id: 'b2', name, colorHex: '#000000', position: 1 },
    })),
    rename: vi.fn(async () => ({ ok: true as const })),
    remove: vi.fn(async () => undefined),
    countIn: () => 2,
  };
  render();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('bucket chips', () => {
  it('adds a bucket on Enter and picks it', async () => {
    act(() => host.querySelector<HTMLButtonElement>('[data-bank-bucket-add]')?.click());
    type(input(), 'Launch');
    await act(async () => {
      key(input(), 'Enter');
      await Promise.resolve();
    });
    expect(writes.create).toHaveBeenCalledWith('Launch');
    expect(buckets.map((b) => b.name)).toEqual(['Product', 'Launch']);
    expect(picked).toBe('b2');
  });

  it('cancels the add on Esc', () => {
    act(() => host.querySelector<HTMLButtonElement>('[data-bank-bucket-add]')?.click());
    key(input(), 'Escape');
    expect(host.querySelector('[data-bank-bucket-input]')).toBeNull();
    expect(writes.create).not.toHaveBeenCalled();
  });

  it('shows a failed add as a toast', async () => {
    writes.create.mockResolvedValueOnce({
      ok: false,
      message: "Couldn't add. That bucket already exists.",
    });
    act(() => host.querySelector<HTMLButtonElement>('[data-bank-bucket-add]')?.click());
    type(input(), 'Product');
    await act(async () => {
      key(input(), 'Enter');
      await Promise.resolve();
    });
    expect(h.toasts).toEqual(["Couldn't add. That bucket already exists."]);
  });

  it('renames in place from the menu', async () => {
    act(() =>
      h.menus
        .get('Product')
        ?.items.find((i) => i.id === 'rename')
        ?.onSelect(),
    );
    type(input(), 'Products');
    await act(async () => {
      key(input(), 'Enter');
      await Promise.resolve();
    });
    expect(writes.rename).toHaveBeenCalledWith('b1', 'Products');
    expect(buckets[0]?.name).toBe('Products');
  });

  it('deletes behind the Undo strip, and Undo brings it back', async () => {
    picked = 'b1';
    render();
    act(() =>
      h.menus
        .get('Product')
        ?.items.find((i) => i.id === 'delete-bucket')
        ?.onSelect(),
    );
    expect(host.querySelector('[data-bank-bucket="b1"]')).toBeNull();
    expect(picked).toBeNull();
    expect(writes.remove).not.toHaveBeenCalled();
    act(() => h.undo[0]?.revert?.());
    expect(host.querySelector('[data-bank-bucket="b1"]')).not.toBeNull();

    act(() =>
      h.menus
        .get('Product')
        ?.items.find((i) => i.id === 'delete-bucket')
        ?.onSelect(),
    );
    await act(async () => {
      await h.undo[1]?.commit();
    });
    expect(writes.remove).toHaveBeenCalledWith('b1');
  });
});

describe('bucket delete line', () => {
  it('reads none, one and many', async () => {
    const { bucketDeleteLine } = await import('./bank-parts');
    expect(bucketDeleteLine(0)).toBeNull();
    expect(bucketDeleteLine(1)).toBe('1 idea keeps its other buckets');
    expect(bucketDeleteLine(3)).toBe('3 ideas keep their other buckets');
  });

  it('gives the laptop menu no second line for an empty bucket', () => {
    writes.countIn = () => 0;
    render();
    const del = h.menus.get('Product')?.items.find((i) => i.id === 'delete-bucket') as
      | { description?: string }
      | undefined;
    expect(del?.description).toBeUndefined();
  });
});

describe('picked chip', () => {
  it('shows the name only, no menu glyph', () => {
    picked = 'b1';
    render();
    const chip = host.querySelector('[data-bank-bucket="b1"]');
    expect(chip?.textContent).toBe('Product');
    expect(chip?.textContent).not.toContain('\u22EF');
  });
});

describe('phone: the bucket menu in place', () => {
  function chip(): HTMLButtonElement {
    const el = host.querySelector<HTMLButtonElement>('[data-bank-bucket="b1"]');
    if (el === null) throw new Error('no chip');
    return el;
  }

  beforeEach(() => {
    h.laptop = false;
    picked = 'b1';
    render();
  });

  it('opens in the card (no ActionMenu, no second sheet) on a second tap', () => {
    act(() => chip().click());
    expect(host.querySelector('[data-bank-bucket-menu="b1"]')).not.toBeNull();
    expect(host.querySelector('[data-bank-buckets]')).toBeNull();
    expect(h.menus.size).toBe(0);
    expect(host.querySelector('[data-bank-bucket-delete-line]')?.textContent).toBe(
      '2 ideas keep their other buckets',
    );
  });

  it('Back returns to the chips with focus on the chip', () => {
    act(() => chip().click());
    act(() => host.querySelector<HTMLButtonElement>('[data-bank-bucket-menu-back]')?.click());
    expect(host.querySelector('[data-bank-bucket-menu]')).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it('Esc returns to the chips', () => {
    act(() => chip().click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(host.querySelector('[data-bank-bucket-menu]')).toBeNull();
    expect(host.querySelector('[data-bank-buckets]')).not.toBeNull();
  });

  it('Rename puts the inline field back among the chips', () => {
    act(() => chip().click());
    act(() => host.querySelector<HTMLButtonElement>('[data-bank-bucket-menu-rename]')?.click());
    expect(input().value).toBe('Product');
  });

  it('Delete hides the chip behind the Undo strip', () => {
    act(() => chip().click());
    act(() => host.querySelector<HTMLButtonElement>('[data-bank-bucket-menu-delete]')?.click());
    expect(host.querySelector('[data-bank-bucket="b1"]')).toBeNull();
    expect(h.undo).toHaveLength(1);
    expect(writes.remove).not.toHaveBeenCalled();
  });

  it('an empty bucket shows Delete bucket with no second line', () => {
    writes.countIn = () => 0;
    render();
    act(() => chip().click());
    expect(host.querySelector('[data-bank-bucket-delete-line]')).toBeNull();
  });
});
