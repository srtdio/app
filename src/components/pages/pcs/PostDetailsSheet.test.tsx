// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Flow B 28: the details sheet's target date is a draft until Done. Changing
// the date input never writes; Done writes the picked day once and closes.
// Spec B3 / B4: no Origin row, the inline "+ New bucket" flow, "Discard
// changes?" on an unsaved date, and the owner row's lock on an approved post.

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/buckets', () => ({
  BUCKET_NAME_MAX: 40,
  listBuckets: async () => ({ ok: true, data: [] }),
}));

import type { Result } from '@srtdio/rpc';
import type { BucketOption } from '@/lib/buckets';
import { NEW_BUCKET_LABEL, PostDetailsSheet } from '@/components/pages/pcs/PostDetailsSheet';
import { targetDateFromInput } from '@/components/pages/pcs/post-date';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(
  over: {
    isAgencySide?: boolean;
    lockedFields?: boolean;
    onCreateBucket?: (name: string) => Promise<Result<BucketOption>>;
  } = {},
) {
  const onClose = vi.fn();
  const onChangeTargetDate = vi.fn();
  const onChangeBucket = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <PostDetailsSheet
        open
        onClose={onClose}
        workspaceId="w1"
        timeZone="Asia/Kolkata"
        isAgencySide={over.isAgencySide ?? true}
        isClient={!(over.isAgencySide ?? true)}
        bucketId={null}
        ownerUserId="u1"
        targetDate="2026-10-20T06:30:00.000Z"
        memberOptions={[]}
        ownerName="Riya Menon"
        ownerAvatarUrl={null}
        onChangeBucket={onChangeBucket}
        onChangeOwner={() => {}}
        onChangeTargetDate={onChangeTargetDate}
        {...(over.lockedFields !== undefined ? { lockedFields: over.lockedFields } : {})}
        {...(over.onCreateBucket !== undefined ? { onCreateBucket: over.onCreateBucket } : {})}
      />,
    );
    await wait(30);
  });
  return { onClose, onChangeTargetDate, onChangeBucket };
}

function setText(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
    await wait(30);
  });
}

function rowButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes(label),
  );
}

function setDate(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const button = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === label,
  );

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PostDetailsSheet target date (flow B 28)', () => {
  it('saves on Done, not on every input change', async () => {
    const { onClose, onChangeTargetDate } = await mount();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Due date"]');
    expect(input).not.toBeNull();
    expect(input?.value).toBe('2026-10-20');

    await act(async () => {
      setDate(input!, '2026-10-27');
    });
    await act(async () => {
      setDate(input!, '2026-10-28');
    });
    expect(onChangeTargetDate).not.toHaveBeenCalled();

    const done = button('Done');
    expect(done).toBeDefined();
    await act(async () => {
      done?.click();
    });
    expect(onChangeTargetDate).toHaveBeenCalledTimes(1);
    expect(onChangeTargetDate).toHaveBeenCalledWith(
      targetDateFromInput('2026-10-28', 'Asia/Kolkata'),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Done with an unchanged date writes nothing and just closes', async () => {
    const { onClose, onChangeTargetDate } = await mount();
    await act(async () => {
      button('Done')?.click();
    });
    expect(onChangeTargetDate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('approvers get no Done (read-only rows)', async () => {
    await mount({ isAgencySide: false });
    expect(button('Done')).toBeUndefined();
    expect(document.querySelector('input[aria-label="Due date"]')).toBeNull();
  });

  it('lockedFields keeps the owner row read-only, with a lock', async () => {
    await mount({ lockedFields: true });
    const ownerRow = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Riya Menon'),
    );
    expect(ownerRow).toBeUndefined();
    expect(document.querySelectorAll('[data-detail-row-lock]')).toHaveLength(1);
    // Due date and bucket stay editable.
    expect(document.querySelector('input[aria-label="Due date"]')).not.toBeNull();
    expect(rowButton('Bucket')).toBeDefined();
  });

  it('no lock on an editable post', async () => {
    await mount();
    expect(document.querySelector('[data-detail-row-lock]')).toBeNull();
  });

  it('B3: no Origin row', async () => {
    await mount();
    expect(document.body.textContent).not.toContain('Origin');
    expect(document.body.textContent).not.toContain('Direct');
  });

  it('B3: closing with an unsaved date asks "Discard changes?" and writes nothing', async () => {
    const { onClose, onChangeTargetDate } = await mount();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Due date"]');
    await act(async () => {
      setDate(input!, '2026-10-29');
    });
    await click(document.querySelector('button[aria-label="Close"]'));
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('Discard changes?');
    expect(onClose).not.toHaveBeenCalled();
    expect(onChangeTargetDate).not.toHaveBeenCalled();
  });

  it('B3: closing with no unsaved date closes at once', async () => {
    const { onClose } = await mount();
    await click(document.querySelector('button[aria-label="Close"]'));
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('B3: no buckets yet: "+ New bucket" creates one and files the post under it', async () => {
    const created: BucketOption = { id: 'bk1', name: 'Festive', colorHex: '#f59e0b', position: 0 };
    const onCreateBucket = vi.fn<(name: string) => Promise<Result<BucketOption>>>(async () => ({
      ok: true,
      data: created,
    }));
    const { onChangeBucket } = await mount({ onCreateBucket });
    await click(rowButton('Bucket'));
    expect(document.body.textContent).not.toContain('No buckets yet');
    expect(NEW_BUCKET_LABEL).toBe('+ New bucket');
    await click(document.querySelector('[data-new-bucket-open]'));
    const name = document.querySelector<HTMLInputElement>('input[aria-label="New bucket name"]');
    await act(async () => {
      setText(name!, '  Festive ');
    });
    await click(document.querySelector('[data-new-bucket-create]'));
    expect(onCreateBucket).toHaveBeenCalledWith('Festive');
    expect(onChangeBucket).toHaveBeenCalledWith('bk1');
  });

  it('B3: a refused create keeps the form with the friendly line', async () => {
    const onCreateBucket = vi.fn<(name: string) => Promise<Result<BucketOption>>>(async () => ({
      ok: false,
      error: { code: 'unknown', message: "That name's already taken." },
    }));
    const { onChangeBucket } = await mount({ onCreateBucket });
    await click(rowButton('Bucket'));
    await click(document.querySelector('[data-new-bucket-open]'));
    const name = document.querySelector<HTMLInputElement>('input[aria-label="New bucket name"]');
    await act(async () => {
      setText(name!, 'Festive');
    });
    await click(document.querySelector('[data-new-bucket-create]'));
    expect(document.querySelector('[data-new-bucket-error]')?.textContent).toBe(
      "That name's already taken.",
    );
    expect(onChangeBucket).not.toHaveBeenCalled();
  });
});
