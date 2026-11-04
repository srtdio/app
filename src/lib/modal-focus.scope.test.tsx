// @vitest-environment jsdom
// A popover portaled out of a Sheet (the DatePicker calendar) registers with
// the modal focus scope, so the Sheet's Tab trap leaves focus in it.
import { act, useRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { inModalScopeNode, useModalScopeNode } from '@/lib/modal-focus';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

function Popover(props: { open: boolean }): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  useModalScopeNode(ref, props.open);
  return (
    <div ref={ref} data-popover="">
      <button type="button">Day</button>
    </div>
  );
}

function mount(node: ReactElement): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root?.render(node));
}

describe('useModalScopeNode', () => {
  it('allow-lists the node only while open', () => {
    mount(<Popover open />);
    const day = document.querySelector('button');
    expect(inModalScopeNode(day)).toBe(true);
    act(() => root?.render(<Popover open={false} />));
    expect(inModalScopeNode(day)).toBe(false);
  });

  it('an element outside every scope node is not in scope', () => {
    mount(<Popover open />);
    const other = document.createElement('button');
    document.body.appendChild(other);
    expect(inModalScopeNode(other)).toBe(false);
    expect(inModalScopeNode(null)).toBe(false);
  });
});
