// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, type ButtonVariant } from '@/components/ui/Button';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'ghost', 'link', 'success', 'danger'];

describe('Button type roles', () => {
  it('every variant renders the button label role: text-base font-medium', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <>
          {VARIANTS.map((variant) => (
            <Button key={variant} variant={variant}>
              {`Label ${variant}`}
            </Button>
          ))}
        </>,
      );
    });
    for (const variant of VARIANTS) {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent === `Label ${variant}`,
      );
      const classes = (button?.className ?? '').split(/\s+/);
      expect(classes).toContain('text-base');
      expect(classes).toContain('font-medium');
      expect(classes).not.toContain('font-semibold');
      expect(classes.some((c) => /^text-(\[|legacy-)/.test(c))).toBe(false);
    }
  });
});
