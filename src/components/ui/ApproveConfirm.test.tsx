import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  ApproveConfirm,
  approveTargetDate,
  type ApproveConfirmProps,
} from '@/components/ui/ApproveConfirm';
import { confirmCopy, postSubject } from '@/components/chat/post-sheet';

function collect(node: ReactNode, found: ReactElement[]): void {
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, found));
    return;
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) return;
  found.push(node);
  collect((node.props as { children?: ReactNode }).children, found);
}

function elements(props: ApproveConfirmProps): ReactElement[] {
  const all: ReactElement[] = [];
  collect(ApproveConfirm(props), all);
  return all;
}

function texts(props: ApproveConfirmProps): string[] {
  return elements(props)
    .map((el) => (el.props as { children?: ReactNode }).children)
    .filter((child): child is string => typeof child === 'string');
}

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

describe('ApproveConfirm', () => {
  it('T6: names the post title, the slide count and the target date when loaded (chat copy)', () => {
    expect(texts(base())).toEqual([
      'Approve Launch teaser, all 4 slides, for Oct 2?',
      'This is logged as your approval and the creators are notified.',
      'Back',
      'Approve',
    ]);
    const chat = confirmCopy('approve', {
      subject: postSubject('Launch teaser'),
      mediaCount: 4,
      targetDate: 'Oct 2',
    });
    expect(texts(base())).toContain(chat.question);
  });

  it('T6: leaves slide count and target date out when not loaded', () => {
    expect(texts(base({ mediaCount: null, targetDate: '' }))[0]).toBe('Approve Launch teaser?');
    expect(texts(base({ mediaCount: null }))[0]).toBe('Approve Launch teaser, for Oct 2?');
    expect(texts(base({ targetDate: '' }))[0]).toBe('Approve Launch teaser, all 4 slides?');
  });

  it('falls back to "this post" for an empty or missing title', () => {
    expect(texts(base({ postTitle: null, mediaCount: null, targetDate: '' }))[0]).toBe(
      'Approve this post?',
    );
    expect(texts(base({ postTitle: '   ', mediaCount: null, targetDate: '' }))[0]).toBe(
      'Approve this post?',
    );
  });

  it('never shows a KEY-N code', () => {
    for (const text of texts(base())) expect(text).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
  });

  it('shows a failed approve above the buttons as the chat sheet does, none by default', () => {
    expect(texts(base({ error: 'Could not approve.' }))).toEqual([
      'Approve Launch teaser, all 4 slides, for Oct 2?',
      'This is logged as your approval and the creators are notified.',
      'Could not approve.',
      'Back',
      'Approve',
    ]);
    const alert = elements(base({ error: 'x' })).find(
      (el) => (el.props as { role?: string }).role === 'alert',
    );
    expect((alert?.props as { className: string }).className).toBe('text-sm text-bad');
    expect(texts(base({ error: null }))).toHaveLength(4);
  });

  it('wires Back and Confirm, both disabled while busy', () => {
    const props = base();
    const buttons = elements(props).filter((el) => el.type === 'button');
    expect(buttons).toHaveLength(2);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(props.onBack).toHaveBeenCalledOnce();
    (buttons[1]!.props as { onClick: () => void }).onClick();
    expect(props.onConfirm).toHaveBeenCalledOnce();
    const busy = elements(base({ busy: true })).filter((el) => el.type === 'button');
    expect(busy.every((el) => (el.props as { disabled: boolean }).disabled)).toBe(true);
  });

  it('uses the chat sheet look: 48px buttons, good fill, tokens only', () => {
    const buttons = elements(base()).filter((el) => el.type === 'button');
    const [back, approve] = buttons.map((el) => (el.props as { className: string }).className);
    expect(back).toContain('h-12');
    expect(back).toContain('border-border bg-panel text-fg');
    expect(approve).toContain('h-12');
    expect(approve).toContain('bg-good-solid');
    expect(`${back} ${approve}`).not.toMatch(/#[0-9a-f]{3,6}|dark:/i);
  });

  it('formats the target date with the app day format', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    expect(approveTargetDate(null, 'UTC', now)).toBe('');
    expect(approveTargetDate('2026-10-02T06:30:00Z', 'Asia/Kolkata', now)).toBe('2 Oct');
    expect(approveTargetDate('2027-01-04T06:30:00Z', 'Asia/Kolkata', now)).toBe('4 Jan 2027');
  });
});
