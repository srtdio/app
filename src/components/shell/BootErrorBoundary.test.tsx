// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const sentry = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock('@/lib/sentry', () => sentry);

import { BootErrorBoundary } from '@/components/shell/BootErrorBoundary';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function Boom(): never {
  throw new Error('render failed');
}

function mount(children: ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(<BootErrorBoundary>{children}</BootErrorBoundary>));
  return host;
}

describe('BootErrorBoundary', () => {
  it('renders its children when nothing throws', () => {
    const host = mount(<p>App</p>);
    expect(host.textContent).toBe('App');
  });

  it('renders the fallback and reports the crash when a child throws', () => {
    // React logs caught render errors; keep test output quiet.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const host = mount(<Boom />);
    expect(host.querySelector('main')?.textContent).toBe(
      'Something went wrong. Refresh to try again.',
    );
    expect(sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'render failed' }),
      expect.objectContaining({ boundary: 'root' }),
    );
  });
});
