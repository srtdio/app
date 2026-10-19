// @vitest-environment jsdom
// X4 (FT51): the row editor's Today is disabled after 9 pm workspace time,
// like the add row; earlier in the day it picks today.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuePicker } from '@/components/chat/tasks/TaskRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function show(nowIso: string, onChange: (v: string | null) => void): HTMLButtonElement | null {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <DuePicker value={null} nowMs={Date.parse(nowIso)} timeZone="UTC" onChange={onChange} />,
    ),
  );
  return document.querySelector<HTMLButtonElement>('[data-task-opt="today"]');
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('X4 row editor Today after 9 pm', () => {
  it('after 9 pm: Today is shown but disabled; a tap changes nothing', () => {
    const onChange = vi.fn();
    const today = show('2026-10-19T21:30:00.000Z', onChange);
    expect(today?.getAttribute('aria-disabled')).toBe('true');
    act(() => today?.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it('before 9 pm: Today picks today', () => {
    const onChange = vi.fn();
    const today = show('2026-10-19T10:00:00.000Z', onChange);
    expect(today?.hasAttribute('aria-disabled')).toBe(false);
    act(() => today?.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(String(onChange.mock.calls[0]?.[0])).toMatch(/^2026-10-19T21:00:00/);
  });
});
