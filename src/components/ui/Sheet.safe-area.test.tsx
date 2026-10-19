// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Sheet } from '@/components/ui/Sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount(withFooter: boolean) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <Sheet
        open
        onClose={() => {}}
        title="New post"
        {...(withFooter ? { footer: <button type="button">Create</button> } : {})}
      >
        <p>body</p>
      </Sheet>,
    );
  });
  const panel = document.querySelector<HTMLElement>('[role="dialog"]');
  if (panel === null) throw new Error('no sheet');
  return { panel };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Sheet bottom edge and height (iPhone)', () => {
  it('the footer clears the home bar: padding-bottom max(12px, env(safe-area-inset-bottom))', async () => {
    const { panel } = await mount(true);
    const footer = panel.lastElementChild;
    expect(footer?.textContent).toBe('Create');
    expect(footer?.className).toContain('pb-[max(12px,env(safe-area-inset-bottom))]');
    expect(footer?.className).toContain('pt-3');
    expect(footer?.className).not.toContain('py-3');
  });

  it('without a footer the body is the bottom edge and clears the home bar too', async () => {
    const { panel } = await mount(false);
    const body = panel.lastElementChild;
    expect(body?.textContent).toBe('body');
    expect(body?.className).toContain('pb-[max(16px,env(safe-area-inset-bottom))]');
  });

  it('caps at 90dvh with 90vh as the fallback', async () => {
    const { panel } = await mount(true);
    expect(panel.className).toContain('max-h-[90vh]');
    expect(panel.className).toContain('supports-[height:1dvh]:max-h-[90dvh]');
  });
});
