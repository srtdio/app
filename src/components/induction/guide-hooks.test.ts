import { describe, expect, it } from 'vitest';
import { domConfirms, freshSeen, type CompletionInput } from './guide-hooks';

const el = {} as HTMLElement;

function input(over: Partial<CompletionInput> = {}): CompletionInput {
  return {
    stepKey: 's',
    enabled: true,
    el,
    nextEl: undefined,
    nextElsewhere: false,
    where: '/pipeline',
    ...over,
  };
}

function tapped(where = '/pipeline') {
  const seen = freshSeen('s');
  seen.found = true;
  seen.tappedAt = performance.now();
  seen.tappedWhere = where;
  return seen;
}

describe('domConfirms: a tap on a control that stays on screen', () => {
  it('is not confirmed while the next control is absent on the same place', () => {
    expect(domConfirms(tapped(), input())).toBe(false);
  });

  it('is confirmed when there is no next step or it lives on another place', () => {
    expect(domConfirms(tapped(), input({ nextElsewhere: true }))).toBe(true);
  });

  it('is confirmed when the location changed after the tap', () => {
    expect(domConfirms(tapped('/chat'), input({ where: '/chat?channel=g1' }))).toBe(true);
  });

  it('is confirmed when the next control is on screen', () => {
    expect(domConfirms(tapped(), input({ nextEl: {} as HTMLElement }))).toBe(true);
  });

  it('expires after TAP_CONFIRM_MS', () => {
    const seen = tapped();
    seen.tappedAt = performance.now() - 5000;
    expect(domConfirms(seen, input({ nextElsewhere: true }))).toBe(false);
    expect(seen.tappedAt).toBe(0);
  });

  it('never confirms without a tap', () => {
    const seen = freshSeen('s');
    seen.found = true;
    expect(domConfirms(seen, input({ nextElsewhere: true }))).toBe(false);
  });
});
