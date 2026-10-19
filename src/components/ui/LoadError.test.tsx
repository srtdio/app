// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadError, loadErrorText } from '@/components/ui/LoadError';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

async function mount(props: { retrying?: boolean } = {}) {
  const onRetry = vi.fn();
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<LoadError title="posts" onRetry={onRetry} {...props} />);
  });
  const alert = document.querySelector<HTMLElement>('[role="alert"]');
  if (alert === null) throw new Error('no alert');
  const retry = alert.querySelector<HTMLButtonElement>('button');
  if (retry === null) throw new Error('no retry');
  return { alert, retry, onRetry };
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('LoadError', () => {
  it('says what could not load, as an alert, with a 44px Retry', async () => {
    const { alert, retry, onRetry } = await mount();
    expect(loadErrorText('posts')).toBe("Couldn't load posts.");
    expect(alert.textContent).toContain("Couldn't load posts.");
    expect(alert.textContent).not.toContain('—');
    expect(retry.textContent).toBe('Retry');
    expect(retry.className).toContain('h-11');
    await act(async () => retry.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('uses tokens only (no palette colours or hex)', async () => {
    const { alert } = await mount();
    const classes = [alert.className, ...[...alert.querySelectorAll('*')].map((el) => el.className)]
      .join(' ')
      .split(/\s+/);
    for (const c of classes) {
      expect(c).not.toMatch(/^(bg|text|border)-(red|gray|slate|zinc|neutral|blue|green)-/);
      expect(c).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
    expect(alert.className).toContain('border-border');
    expect(alert.className).toContain('bg-panel');
  });

  it('while retrying the button is disabled and says so', async () => {
    const { retry } = await mount({ retrying: true });
    expect(retry.disabled).toBe(true);
    expect(retry.getAttribute('aria-busy')).toBe('true');
    expect(retry.textContent).toBe('Retrying…');
  });
});
