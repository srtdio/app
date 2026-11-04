// @vitest-environment jsdom
// The app root goes inert while a modal outside it is open; refcounted so a
// confirm over a sheet wakes the page only when both close.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appInertHolds, holdAppInert } from '@/lib/app-inert';

let root: HTMLElement;
let panel: HTMLElement;

beforeEach(() => {
  root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
  panel = document.createElement('div');
  document.body.appendChild(panel);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('holdAppInert', () => {
  it('marks #root inert while held and wakes it on release', () => {
    const release = holdAppInert(panel);
    expect(root.hasAttribute('inert')).toBe(true);
    release();
    expect(root.hasAttribute('inert')).toBe(false);
    expect(appInertHolds()).toBe(0);
  });

  it('is refcounted: the root wakes only when the last modal closes', () => {
    const sheet = holdAppInert(panel);
    const confirm = holdAppInert(panel);
    sheet();
    expect(root.hasAttribute('inert')).toBe(true);
    confirm();
    expect(root.hasAttribute('inert')).toBe(false);
  });

  it('a release called twice counts once', () => {
    const a = holdAppInert(panel);
    const b = holdAppInert(panel);
    a();
    a();
    expect(root.hasAttribute('inert')).toBe(true);
    b();
    expect(root.hasAttribute('inert')).toBe(false);
  });

  it('a modal rendered inside #root never freezes itself', () => {
    const inside = document.createElement('div');
    root.appendChild(inside);
    const release = holdAppInert(inside);
    expect(root.hasAttribute('inert')).toBe(false);
    expect(appInertHolds()).toBe(0);
    release();
  });

  it('no panel or no #root is a no-op', () => {
    holdAppInert(null)();
    root.remove();
    holdAppInert(panel)();
    expect(appInertHolds()).toBe(0);
  });
});
