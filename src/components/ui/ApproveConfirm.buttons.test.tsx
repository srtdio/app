// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApproveConfirm, type ApproveConfirmProps } from '@/components/ui/ApproveConfirm';

// The button system: Approve is the green success button and Back the
// secondary one, both 44 tall with an 8px radius, in both confirm modes.

function base(over: Partial<ApproveConfirmProps> = {}): ApproveConfirmProps {
  return {
    postTitle: 'Launch teaser',
    mediaCount: 4,
    targetDate: 'Oct 2',
    busy: false,
    onBack: vi.fn(),
    onConfirm: vi.fn(),
    ...over,
  };
}

function classesOf(props: ApproveConfirmProps, selector: string): string[] {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<ApproveConfirm {...props} />);
  const el = host.querySelector(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el.className.split(/\s+/);
}

const STALE = ['h-9', 'h-10', 'h-12', 'rounded-md', 'rounded-xl', 'font-semibold', 'bg-good'];

describe.each(['question', 'summary'] as const)('ApproveConfirm buttons (%s)', (mode) => {
  it('Approve is success: bg-good-solid, h-11, rounded-lg', () => {
    const classes = classesOf(base({ mode }), '[data-approve-confirm-button]');
    expect(classes).toEqual(expect.arrayContaining(['bg-good-solid', 'h-11', 'rounded-lg']));
    for (const stale of STALE) expect(classes).not.toContain(stale);
  });

  it('Back is secondary: bg-panel with a border, h-11, rounded-lg', () => {
    const classes = classesOf(base({ mode }), '[data-approve-back]');
    expect(classes).toEqual(
      expect.arrayContaining(['bg-panel', 'border', 'border-border', 'h-11', 'rounded-lg']),
    );
    expect(classes).not.toContain('bg-good-solid');
    for (const stale of STALE) expect(classes).not.toContain(stale);
  });
});
