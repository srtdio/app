import { describe, expect, it, vi } from 'vitest';
import type { ReactElement, ReactNode } from 'react';
import {
  APPROVE_CONFIRM_TITLE,
  ApproveConfirm,
  approveConfirmBody,
  approveTargetDate,
  type ApproveConfirmProps,
} from '@/components/ui/ApproveConfirm';
import { Button } from '@/components/ui/Button';
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
    expect((alert?.props as { className: string }).className).toBe('text-base text-bad');
    expect(texts(base({ error: null }))).toHaveLength(4);
  });

  it('wires Back and Confirm, both disabled while busy', () => {
    const props = base();
    const buttons = elements(props).filter((el) => el.type === Button);
    expect(buttons).toHaveLength(2);
    (buttons[0]!.props as { onClick: () => void }).onClick();
    expect(props.onBack).toHaveBeenCalledOnce();
    (buttons[1]!.props as { onClick: () => void }).onClick();
    expect(props.onConfirm).toHaveBeenCalledOnce();
    const busy = elements(base({ busy: true })).filter((el) => el.type === Button);
    expect(busy.every((el) => (el.props as { disabled: boolean }).disabled)).toBe(true);
  });

  it('Back is secondary, Approve the success variant, no size, tokens only', () => {
    const buttons = elements(base()).filter((el) => el.type === Button);
    const [back, approve] = buttons.map(
      (el) => el.props as { variant?: string; size?: string; className: string },
    );
    expect(back?.variant).toBe('secondary');
    expect(back?.size).toBeUndefined();
    expect(approve?.variant).toBe('success');
    expect(approve?.size).toBeUndefined();
    expect(`${back?.className} ${approve?.className}`).not.toMatch(/#[0-9a-f]{3,6}|dark:|rgba/i);
  });

  it('formats the target date with the app day format', () => {
    const now = new Date('2026-10-23T12:00:00Z');
    expect(approveTargetDate(null, 'UTC', now)).toBe('');
    expect(approveTargetDate('2026-10-02T06:30:00Z', 'Asia/Kolkata', now)).toBe('2 Oct');
    expect(approveTargetDate('2027-01-04T06:30:00Z', 'Asia/Kolkata', now)).toBe('4 Jan 2027');
  });
});

describe('ApproveConfirm summary mode (post screen)', () => {
  const summary = (over: Partial<ApproveConfirmProps> = {}): ApproveConfirmProps =>
    base({ mode: 'summary', targetDate: '20 Jul', ...over });

  it('the sheet title is the question, never the format', () => {
    expect(APPROVE_CONFIRM_TITLE).toBe('Approve this post?');
  });

  it('one body line "{n} slides · due {date}", then Back and Approve; never the post title', () => {
    expect(texts(summary())).toEqual(['4 slides · due 20 Jul', 'Back', 'Approve']);
    for (const text of texts(summary())) expect(text).not.toContain('Launch teaser');
  });

  it('omits missing parts and says "1 slide"', () => {
    expect(texts(summary({ mediaCount: 1 }))[0]).toBe('1 slide · due 20 Jul');
    expect(texts(summary({ mediaCount: null }))[0]).toBe('due 20 Jul');
    expect(texts(summary({ targetDate: '' }))[0]).toBe('4 slides');
    expect(texts(summary({ mediaCount: null, targetDate: '' }))).toEqual(['Back', 'Approve']);
    expect(
      elements(summary({ mediaCount: null, targetDate: '' })).some(
        (el) => 'data-approve-summary' in (el.props as object),
      ),
    ).toBe(false);
  });

  it('approveConfirmBody is pure and drops a zero count', () => {
    expect(approveConfirmBody({ slides: 3, dueDay: '2 Oct' })).toBe('3 slides · due 2 Oct');
    expect(approveConfirmBody({ slides: 0, dueDay: '' })).toBe('');
    expect(approveConfirmBody({ slides: 1, dueDay: '' })).toBe('1 slide');
  });

  it('shows a failed approve above the buttons', () => {
    expect(texts(summary({ error: 'Could not approve.' }))).toEqual([
      '4 slides · due 20 Jul',
      'Could not approve.',
      'Back',
      'Approve',
    ]);
  });

  it('no em-dashes in the copy', () => {
    for (const text of texts(summary())) expect(text).not.toContain('\u2014');
  });
});
