import { expect, type Page, type TestInfo } from '@playwright/test';
import { INDUCTION_KEYS, inductionSelector, type InductionKey } from '../../src/lib/induction-keys';
import { fillCopy } from '../../src/lib/induction-copy';
import type { CopyContext, Step } from '../../src/lib/induction-model';
import { expectMinTouchTarget } from './touch-target';

// Shared checks for the onboarding guide specs (onboarding-*.spec.ts). The
// guide marks its pieces with data attributes (GuideParts.tsx): the layer
// carries data-induction-step (the step or card id), the hairline
// data-induction-box, the hand data-induction-hand, the pill
// data-induction-label, the bar data-induction-bar and the cards
// data-induction-card. Copy and keys come from the src modules, so a copy
// change can never leave the specs asserting old strings.

export { INDUCTION_KEYS, inductionSelector };

/** The hairline sits 5px gap plus 2px air off the control (BOX_GAP + BOX_AIR). */
const OUTSET = 7;
/** clampToViewport keeps the box 2px inside the screen edge. */
const SCREEN_EDGE = 2;
/** The fingertip spot inside the 40px hand (HAND_TIP in GuideParts.tsx). */
const HAND_TIP = { x: 17, y: 1 };
/** How far beside the control the fingertip may sit and still read as pressing it. */
const TIP_SLACK = 8;

export interface R {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: R, b: R): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function inside(p: { x: number; y: number }, r: R, slack = 0): boolean {
  return (
    p.x >= r.x - slack &&
    p.x <= r.x + r.width + slack &&
    p.y >= r.y - slack &&
    p.y <= r.y + r.height + slack
  );
}

/** The copy context the specs fill placeholders with (the fixture brand, platform, post). */
export function copyContext(over: Partial<CopyContext> = {}): CopyContext {
  return {
    brand: 'Harness Studio',
    platform: 'LinkedIn',
    post: '',
    creator: '',
    inviter: '',
    email: '',
    ...over,
  };
}

/** The id on the guide layer: a step id, an intro or closing card id, or null when off. */
export async function guideId(page: Page): Promise<string | null> {
  return page
    .locator('[data-induction-step]')
    .getAttribute('data-induction-step', { timeout: 500 })
    .catch(() => null);
}

export async function expectGuideId(page: Page, id: string, timeout = 15_000): Promise<void> {
  await expect
    .poll(() => guideId(page), { message: `guide on ${id}`, timeout, intervals: [100, 200] })
    .toBe(id);
}

async function rectOf(page: Page, selector: string): Promise<R | null> {
  return page.evaluate((s) => {
    for (const el of Array.from(document.querySelectorAll(s))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    }
    return null;
  }, selector);
}

async function viewport(page: Page): Promise<{ w: number; h: number }> {
  return page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
}

/**
 * Attribute narrowing per key, as the guide's qualifiers do (InductionProvider):
 * the default group's row by its channel, the review post's row by its id.
 */
export type Narrow = Partial<Record<InductionKey, string>>;

function selectorFor(key: InductionKey, narrow: Narrow): string {
  return `${inductionSelector(key)}${narrow[key] ?? ''}`;
}

interface Pieces {
  control: R;
  box: R;
  hand: R;
  label: R;
  /** null on a step with nothing to add (no why, no chips): the bar is not shown. */
  bar: R | null;
  vp: { w: number; h: number };
}

/** Every guide piece and the step's control in one read; null while any is missing. */
async function readPieces(page: Page, controlSelectors: string[]): Promise<Pieces | null> {
  return page.evaluate((controls) => {
    const rect = (el: Element | null) => {
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0
        ? { x: r.left, y: r.top, width: r.width, height: r.height }
        : null;
    };
    const first = (selector: string) => {
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const r = rect(el);
        if (r !== null) return r;
      }
      return null;
    };
    let control = null;
    for (const selector of controls) {
      control = first(selector);
      if (control !== null) break;
    }
    const box = first('[data-induction-box]');
    const hand = first('[data-induction-hand]');
    const label = first('[data-induction-label]');
    const bar = first('[data-induction-bar]');
    if (control === null || box === null || hand === null || label === null) {
      return null;
    }
    return { control, box, hand, label, bar, vp: { w: window.innerWidth, h: window.innerHeight } };
  }, controlSelectors);
}

/** The first shown control for a step (the guide boxes the first visible target, key order). */
async function controlFor(
  page: Page,
  step: Step,
  narrow: Narrow = {},
): Promise<{ selector: string; rect: R } | null> {
  for (const key of step.targets) {
    const selector = selectorFor(key, narrow);
    const rect = await rectOf(page, selector);
    if (rect !== null) return { selector, rect };
  }
  return null;
}

function expectedBox(control: R, vp: { w: number; h: number }): R {
  const left = Math.max(control.x - OUTSET, SCREEN_EDGE);
  const top = Math.max(control.y - OUTSET, SCREEN_EDGE);
  const right = Math.min(control.x + control.width + OUTSET, vp.w - SCREEN_EDGE);
  const bottom = Math.min(control.y + control.height + OUTSET, vp.h - SCREEN_EDGE);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function worst(a: R, b: R): number {
  return Math.max(
    Math.abs(a.x - b.x),
    Math.abs(a.y - b.y),
    Math.abs(a.width - b.width),
    Math.abs(a.height - b.height),
  );
}

/** Horizontal scroll never appears (the guide is fixed and absolute pieces stay inside). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const over = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(over, 'no horizontal scroll').toBeLessThanOrEqual(0);
}

/** Every chip in the guide bar is a 44px touch target. No Skip; Back hides on the first step. */
async function expectBarChips(page: Page, opts: { back: boolean | undefined }): Promise<void> {
  const bar = page.locator('[data-induction-bar]');
  await expect(bar.locator('[data-induction-skip]')).toHaveCount(0);
  if (opts.back !== undefined) {
    await expect(bar.locator('[data-induction-back]')).toHaveCount(opts.back ? 1 : 0);
  }
  for (const chip of await bar.getByRole('button').all()) {
    expectMinTouchTarget(await chip.boundingBox());
  }
}

/** A point on screen clear of the box, the bar, the label and the hand, for a tap away. */
async function pointAway(page: Page, avoid: R[]): Promise<{ x: number; y: number }> {
  const vp = await viewport(page);
  const grow = (r: R): R => ({
    x: r.x - 12,
    y: r.y - 12,
    width: r.width + 24,
    height: r.height + 24,
  });
  const zones = avoid.map(grow);
  for (const fy of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
    for (const fx of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const p = { x: Math.round(vp.w * fx), y: Math.round(vp.h * fy) };
      if (!zones.some((z) => inside(p, z))) return p;
    }
  }
  throw new Error('no point clear of the guide for a tap away');
}

export interface StepCheck {
  step: Step;
  ctx: CopyContext;
  /**
   * Back shows (true) or hides (false: the route's first step). Left out where
   * the engine decides by what is on screen (Back goes to the nearest earlier
   * step whose control is visible, so it hides right after a screen change).
   */
  back?: boolean;
  /** Screenshot name, only on the few steps the spec keeps a picture of. */
  shot?: string;
  narrow?: Narrow;
}

/**
 * The guide is on `step` and holds the spec: one hairline at control + 7px,
 * the hand on the control, the label (copy module text) inside the viewport
 * and clear of the box, the why line in the bar, the bar clear of the control,
 * 44px chips, a tap away changes nothing, no horizontal scroll.
 */
export async function expectStep(page: Page, info: TestInfo, check: StepCheck): Promise<R> {
  const { step, ctx } = check;
  await expectGuideId(page, step.id);
  const box = page.locator('[data-induction-box]');
  await expect(box, `box on ${step.id}`).toBeVisible({ timeout: 10_000 });
  await expect(box).toHaveCount(1);

  // One reading of every piece at once (control, hairline, hand, label, bar),
  // taken when the guide shows them all and the hairline sits on the control
  // (control rect plus 7px each side, 1px tolerance). Reading them one by one
  // could straddle a frame where the guide briefly drops the spotlight.
  const selectors = step.targets.map((key) => selectorFor(key, check.narrow ?? {}));
  let shot: Pieces | null = null;
  await expect
    .poll(
      async () => {
        shot = await readPieces(page, selectors);
        if (shot === null) return 99;
        return worst(shot.box, expectedBox(shot.control, shot.vp));
      },
      { message: `hairline on ${step.id}`, timeout: 5_000, intervals: [100, 200] },
    )
    .toBeLessThanOrEqual(1);
  const pieces = shot as unknown as Pieces;
  const ctl = pieces.control;
  const vp = pieces.vp;
  const boxRect = pieces.box;
  const hand = pieces.hand;

  // The hand presses the control: its fingertip inside or just beside it.
  const tip = { x: hand.x + HAND_TIP.x, y: hand.y + HAND_TIP.y };
  expect(inside(tip, ctl, TIP_SLACK), `fingertip on ${step.id}`).toBe(true);

  // The label: the copy module's text, in the viewport, never over the box.
  const label = page.locator('[data-induction-label]');
  await expect(label).toHaveText(fillCopy(step.label, ctx));
  const labelRect = pieces.label;
  const labelIn =
    labelRect.x >= 0 &&
    labelRect.y >= 0 &&
    labelRect.x + labelRect.width <= vp.w &&
    labelRect.y + labelRect.height <= vp.h;
  expect(labelIn, `label inside the viewport on ${step.id}`).toBe(true);
  expect(overlaps(labelRect, boxRect), `label clear of the box on ${step.id}`).toBe(false);

  // The bar: the why line, never over the control, 44px chips, Back as expected.
  const bar = page.locator('[data-induction-bar]');
  if (step.why !== '')
    await expect(bar.getByText(fillCopy(step.why, ctx), { exact: true })).toBeVisible();
  const barRect = pieces.bar;
  if (barRect === null) {
    // One message on screen: a step with no why and no chips shows the label only.
    expect(step.why, `no bar only when there is no why, on ${step.id}`).toBe('');
    expect(check.back ?? false, `no bar means no Back on ${step.id}`).toBe(false);
  } else {
    expect(overlaps(barRect, ctl), `bar clear of the control on ${step.id}`).toBe(false);
    expect(overlaps(labelRect, barRect), `label clear of the bar on ${step.id}`).toBe(false);
    await expectBarChips(page, { back: check.back });
  }
  await expectNoHorizontalScroll(page);

  if (check.shot !== undefined)
    await page.screenshot({ path: info.outputPath(`${check.shot}.png`) });

  // A tap away from the control only nudges: same step, same screen.
  const url = page.url();
  // Every guide control on screen is avoided too: on a field step the guard
  // lets the next step's control through by design, and on a gate it lets the
  // boxed control's whole form through.
  const anchors = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-induction]'))
      .map((el) => el.closest('form') ?? el)
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height })),
  );
  const away = await pointAway(page, [
    boxRect,
    ...(barRect !== null ? [barRect] : []),
    labelRect,
    hand,
    ...anchors,
  ]);
  await page.mouse.click(away.x, away.y);
  await page.waitForTimeout(150);
  expect(await guideId(page), `tap away keeps ${step.id}`).toBe(step.id);
  expect(page.url(), `tap away keeps the screen on ${step.id}`).toBe(url);
  return ctl;
}

/** The real tap on the step's control (the first visible target). */
export async function tapControl(page: Page, step: Step, narrow: Narrow = {}): Promise<void> {
  const found = await controlFor(page, step, narrow);
  if (found === null) throw new Error(`no control for ${step.id}`);
  await page.locator(found.selector).filter({ visible: true }).first().click();
}

/** A card is up: its title and button, no hairline under it, and the card inside the viewport. */
export async function expectCard(
  page: Page,
  opts: { id: string; kind: 'intro' | 'closing'; title: string; button: string },
): Promise<void> {
  await expectGuideId(page, opts.id);
  const card = page.locator(`[data-induction-card="${opts.kind}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(opts.title);
  const button = card.getByRole('button', { name: opts.button, exact: true });
  await expect(button).toBeVisible();
  expectMinTouchTarget(await button.boundingBox());
  const cardRect = (await rectOf(page, `[data-induction-card="${opts.kind}"]`)) as R;
  const boxRect = await rectOf(page, '[data-induction-box]');
  if (boxRect !== null) expect(overlaps(cardRect, boxRect), 'card clear of the box').toBe(false);
  const vp = await viewport(page);
  expect(cardRect.y + cardRect.height).toBeLessThanOrEqual(vp.h);
  await expectNoHorizontalScroll(page);
}

/** Console errors and page errors, collected for the whole test. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(`${String(error)}\n${error.stack ?? ''}`));
  return errors;
}

/**
 * Whether the guide lands on `id` with its hairline up within `timeout` (for
 * the soft checks on known product bugs, so the walk can carry on).
 */
export async function reaches(
  page: Page,
  id: string,
  timeout = 2_000,
  opts: { box: boolean } = { box: true },
): Promise<boolean> {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (
      (await guideId(page)) === id &&
      (!opts.box || (await page.locator('[data-induction-box]').count()) === 1)
    ) {
      return true;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

/**
 * Select the first words of the post's caption, as a drag would, so its
 * Comment button shows (CaptionView starts a comment from a text selection on
 * mouseup; a plain tap selects nothing).
 */
export async function selectCaptionWords(page: Page): Promise<void> {
  await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const walker = root !== null ? document.createTreeWalker(root, NodeFilter.SHOW_TEXT) : null;
    let text = walker?.nextNode() ?? null;
    while (text !== null && (text.textContent ?? '').trim() === '')
      text = walker?.nextNode() ?? null;
    if (text === null) throw new Error('no caption text');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(10, text.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    text.parentElement?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  }, inductionSelector(INDUCTION_KEYS.postCaptionText));
}

/** The photo step: tap the control and pick a file in the chooser it opens. */
export async function pickPhoto(
  page: Page,
  step: Step,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  const chooser = page.waitForEvent('filechooser', { timeout: 5_000 });
  await tapControl(page, step);
  await (await chooser).setFiles(file);
}
