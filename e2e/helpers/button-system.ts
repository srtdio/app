import { expect, type Locator, type Page } from '@playwright/test';

// The button system (locked): every button, chip and icon button is 44 tall
// with an 8px radius, or a 44px circle for shape="round". This helper reads
// every visible control on a screen and reports the ones that drift.
//
// Collected: button, [role="button"], and anchors styled as a button (the
// buttonClass recipe carries h-11). Skipped:
// - anything inside the public homepage markup (.home or [data-home]);
// - anything carrying, or inside, [data-touch-exempt] (the explicit opt-out);
// - elements with an empty box (not laid out) or a 1px sr-only box;
// - elements with a non-button role (tab, option, menuitem, radio, ...): they
//   are list rows or tab bars with their own measured specs;
// - display: inline controls that flow inside text (an inline mention).
// Raw <button> wrappers (list rows, tiles, cards, backdrops) are allowed by the
// system; taller than WRAPPER_MIN_HEIGHT they are checked for height only.

/** WebKit reports sub-pixel layout sizes (43.99998 for a 44px box). */
const HEIGHT_TOLERANCE = 0.5;
const MIN_HEIGHT = 44;
const RADIUS = 8;
/** Taller than this, a control is a wrapper row, tile or card: radius not checked. */
const WRAPPER_MIN_HEIGHT = 56;

const SELECTOR = 'button, [role="button"], a.h-11';
const EXCLUDE = '.home, [data-home], [data-touch-exempt]';

export interface ButtonViolation {
  /** A short readable name: tag, aria-label or text, and any data-* keys. */
  name: string;
  height: number;
  radius: string;
  problem: 'height' | 'radius';
}

interface Args {
  selector: string;
  exclude: string;
  minHeight: number;
  tolerance: number;
  radius: number;
  wrapperMinHeight: number;
}

/** Every visible control in `scope` (default: the whole page) that breaks the system. */
export async function collectButtonViolations(
  page: Page,
  scope?: string | Locator,
): Promise<{ checked: number; violations: ButtonViolation[] }> {
  const root: Locator =
    scope === undefined
      ? page.locator('body')
      : typeof scope === 'string'
        ? page.locator(scope).first()
        : scope.first();
  const args: Args = {
    selector: SELECTOR,
    exclude: EXCLUDE,
    minHeight: MIN_HEIGHT,
    tolerance: HEIGHT_TOLERANCE,
    radius: RADIUS,
    wrapperMinHeight: WRAPPER_MIN_HEIGHT,
  };
  return root.evaluate((host, a: Args) => {
    const out: {
      name: string;
      height: number;
      radius: string;
      problem: 'height' | 'radius';
    }[] = [];
    let checked = 0;
    const allowedRoles = new Set(['', 'button']);
    const describe = (el: Element): string => {
      const label =
        el.getAttribute('aria-label') ??
        (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const data = el
        .getAttributeNames()
        .filter((n) => n.startsWith('data-'))
        .slice(0, 3)
        .join(' ');
      return `<${el.tagName.toLowerCase()}> "${label}"${data !== '' ? ` [${data}]` : ''}`;
    };
    for (const el of Array.from(host.querySelectorAll<HTMLElement>(a.selector))) {
      if (el.closest(a.exclude) !== null) continue;
      const role = el.getAttribute('role') ?? '';
      if (el.tagName === 'BUTTON' || el.tagName === 'A') {
        if (!allowedRoles.has(role)) continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width <= 1 || rect.height <= 1) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      if (style.display === 'inline') continue;
      checked += 1;
      const corners = [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomRightRadius,
        style.borderBottomLeftRadius,
      ];
      const radiusText = corners.join(' ');
      if (rect.height < a.minHeight - a.tolerance) {
        out.push({
          name: describe(el),
          height: rect.height,
          radius: radiusText,
          problem: 'height',
        });
        continue;
      }
      if (rect.height > a.wrapperMinHeight) continue;
      const px = corners.map((c) => Number.parseFloat(c));
      const eight = px.every((v) => Math.abs(v - a.radius) < 0.01);
      const round = px.every((v) => v >= rect.height / 2 - a.tolerance);
      if (!eight && !round) {
        out.push({
          name: describe(el),
          height: rect.height,
          radius: radiusText,
          problem: 'radius',
        });
      }
    }
    return { checked, violations: out };
  }, args);
}

/**
 * Asserts every visible button in `scope` is 44 tall (0.5px rounding allowed)
 * with an 8px radius or a full round. Fails with the list of offenders, and
 * when the screen has no button at all (an unloaded screen must not pass).
 */
export async function expectButtonsMeetSystem(
  page: Page,
  scope?: string | Locator,
): Promise<void> {
  const { checked, violations } = await collectButtonViolations(page, scope);
  expect(checked, 'buttons checked on this screen').toBeGreaterThan(0);
  const lines = violations.map(
    (v) => `${v.problem}: ${v.name} height ${v.height.toFixed(2)} radius ${v.radius}`,
  );
  expect(lines, `button system violations:\n${lines.join('\n')}`).toEqual([]);
}
