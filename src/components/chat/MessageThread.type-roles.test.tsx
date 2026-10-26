// @vitest-environment jsdom
// Type roles in the chat thread: the header name and its second line keep
// the chat-type.ts sizes (WhatsApp lock) on both tables; the Seen line's
// time is sans tabular figures (not mono); the day pill and the Forwarded
// meta keep their sizes. Pure renders; nothing reads.

import { describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// MessageThread's import graph pulls the real agora-chat browser SDK; never in node.
vi.mock('agora-chat', () => ({
  default: { connection: vi.fn(), message: { create: vi.fn() } },
}));
vi.mock('@/lib/supabase', () => ({ supabase: { from: vi.fn(), rpc: vi.fn() } }));

import { DayPill, ForwardedLabel, ThreadHeaderIdentity } from '@/components/chat/MessageThread';
import { SeenLine } from '@/components/chat/ReadingLayer';
import {
  BUBBLE_META_TYPE,
  DATE_PILL_TYPE,
  HEADER_LINE_TYPE,
  HEADER_NAME_TYPE,
  type ChatLayout,
} from '@/components/chat/chat-type';
import { formatTime } from '@/lib/time';

/** Render into the document and return the first element matching `selector` with `text`. */
function paint(node: ReactElement, selector: string, text: string): HTMLElement {
  document.body.innerHTML = renderToStaticMarkup(node);
  const el = [...document.querySelectorAll<HTMLElement>(selector)].find(
    (e) => (e.textContent ?? '').trim() === text,
  );
  if (el === undefined) throw new Error(`no ${selector} reading "${text}"`);
  return el;
}

const classes = (el: Element): string[] => el.className.split(/\s+/);
const tokens = (cls: string): string[] => cls.split(/\s+/);

function header(layout: ChatLayout): ReactElement {
  return (
    <ThreadHeaderIdentity
      isGroup
      title="Launch crew"
      avatarUrl={null}
      presence={undefined}
      headerLine="Asha, Leo, You"
      layout={layout}
    />
  );
}

describe('chat thread type roles', () => {
  for (const layout of ['touch', 'laptop'] as const) {
    it(`${layout}: header name (title) and line (meta) take the chat-type.ts values`, () => {
      const name = paint(header(layout), 'span', 'Launch crew');
      expect(classes(name)).toEqual(
        expect.arrayContaining(['truncate', 'text-fg', ...tokens(HEADER_NAME_TYPE[layout])]),
      );
      const line = paint(header(layout), '[data-header-line]', 'Asha, Leo, You');
      expect(classes(line)).toEqual(
        expect.arrayContaining(['text-fg-3', ...tokens(HEADER_LINE_TYPE[layout])]),
      );
    });

    it(`${layout}: the day pill keeps the chat-type.ts pill size`, () => {
      const pill = paint(<DayPill label="Today" layout={layout} />, 'span', 'Today');
      expect(classes(pill)).toEqual(
        expect.arrayContaining(['text-fg-3', ...tokens(DATE_PILL_TYPE[layout])]),
      );
    });
  }

  it('the chat-type.ts tokens themselves are unchanged (WhatsApp lock)', () => {
    expect(HEADER_NAME_TYPE.touch).toBe('text-[17px] leading-[22px] font-semibold');
    expect(HEADER_NAME_TYPE.laptop).toBe('text-lg font-medium');
    expect(HEADER_LINE_TYPE.touch).toBe('text-[13px] leading-[16px] font-normal');
    expect(BUBBLE_META_TYPE).toBe('text-[11px] leading-[15px] font-normal tabular-nums');
  });

  it('Seen line meta: muted bubble meta size; the time is sans tabular, never mono', () => {
    const at = '2026-10-02T10:05:00Z';
    const time = formatTime(at, 'UTC');
    const span = paint(<SeenLine readAt={at} timeZone="UTC" />, 'span', time);
    expect(classes(span)).toEqual(expect.arrayContaining(['font-sans', 'tabular-nums']));
    expect(classes(span)).not.toContain('font-mono');
    const line = span.parentElement as HTMLElement;
    expect(classes(line)).toEqual(
      expect.arrayContaining(['text-fg-3', ...tokens(BUBBLE_META_TYPE)]),
    );
  });

  it('Forwarded meta: sm in secondary ink', () => {
    const label = paint(<ForwardedLabel />, '[data-forwarded]', 'Forwarded');
    expect(classes(label)).toEqual(expect.arrayContaining(['text-sm', 'text-fg-2']));
  });
});
