// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Flow B 28: the details sheet's target date is a draft until Done. Changing
// the date input never writes; Done writes the picked day once and closes.

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/buckets', () => ({
  listBuckets: async () => ({ ok: true, data: [] }),
}));

import { PostDetailsSheet } from '@/components/pages/pcs/PostDetailsSheet';
import { targetDateFromInput } from '@/components/pages/pcs/post-date';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(over: { isAgencySide?: boolean; lockedFields?: boolean } = {}) {
  const onClose = vi.fn();
  const onChangeTargetDate = vi.fn();
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
        origin="direct"
        memberOptions={[]}
        ownerName="Riya Menon"
        ownerAvatarUrl={null}
        onChangeBucket={() => {}}
        onChangeOwner={() => {}}
        onChangeTargetDate={onChangeTargetDate}
        {...(over.lockedFields !== undefined ? { lockedFields: over.lockedFields } : {})}
      />,
    );
    await wait(30);
  });
  return { onClose, onChangeTargetDate };
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
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Target date"]');
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
    expect(document.querySelector('input[aria-label="Target date"]')).toBeNull();
  });

  it('lockedFields keeps the owner row read-only', async () => {
    await mount({ lockedFields: true });
    const ownerRow = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Riya Menon'),
    );
    expect(ownerRow).toBeUndefined();
  });
});
