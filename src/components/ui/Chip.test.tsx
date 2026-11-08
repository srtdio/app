// Chip announces its own state: aria-pressed on a toggle chip, role="tab" +
// aria-selected on a tab chip, neither on an action chip.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  Chip,
  CHIP_FACE_SIZE,
  CHIP_PICKED_EDGE,
  CHIP_REST_EDGE,
  chipStateAria,
} from '@/components/ui/Chip';

describe('chipStateAria', () => {
  it('toggle chips are aria-pressed; tab chips are role tab + aria-selected', () => {
    expect(chipStateAria(true, false)).toEqual({ 'aria-pressed': true });
    expect(chipStateAria(false, false)).toEqual({ 'aria-pressed': false });
    expect(chipStateAria(undefined, false)).toEqual({});
    expect(chipStateAria(true, true)).toEqual({ role: 'tab', 'aria-selected': true });
    expect(chipStateAria(undefined, true)).toEqual({ role: 'tab', 'aria-selected': false });
  });
});

describe('Chip aria', () => {
  it('a selected toggle chip renders aria-pressed="true"', () => {
    const html = renderToStaticMarkup(<Chip label="Open" selected />);
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain('role="tab"');
  });

  it('an unselected toggle chip renders aria-pressed="false"', () => {
    expect(renderToStaticMarkup(<Chip label="Open" selected={false} />)).toContain(
      'aria-pressed="false"',
    );
  });

  it('a tab chip renders role="tab" with aria-selected, never aria-pressed', () => {
    const html = renderToStaticMarkup(<Chip label="Media" tab selected />);
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain('aria-pressed');
  });

  it('a call site role="tab" is a tab chip too', () => {
    const html = renderToStaticMarkup(<Chip label="Users" role="tab" selected={false} />);
    expect(html).toContain('aria-selected="false"');
    expect(html).not.toContain('aria-pressed');
  });

  it('an action chip (no selected) carries no state', () => {
    const html = renderToStaticMarkup(<Chip label="Add" variant="add" />);
    expect(html).not.toContain('aria-pressed');
    expect(html).not.toContain('aria-selected');
  });

  it('the pick is the ink outline (no fill) and marks itself for the slide', () => {
    const toggle = renderToStaticMarkup(<Chip label="Open" selected />);
    expect(toggle).toContain('border-fg text-fg');
    expect(toggle).not.toMatch(/bg-accent|lit-pill|bg-panel-3|lit-well-soft/);
    expect(toggle).toContain('data-selected="true"');
    const tab = renderToStaticMarkup(<Chip label="Open" tab selected />);
    expect(tab).toContain('border-fg text-fg');
    expect(tab).not.toMatch(/bg-accent|lit-pill/);
    const idle = renderToStaticMarkup(<Chip label="Open" selected={false} />);
    expect(idle).toContain('border-border-strong text-fg-2');
    expect(idle).not.toMatch(/bg-panel-3|lit-well-soft|bg-accent|lit-pill/);
    expect(idle).not.toContain('data-selected');
  });

  it('the count reads quieter than the label: tabular fg-3', () => {
    const html = renderToStaticMarkup(<Chip label="Open" count={3} selected={false} />);
    expect(html).toContain('<span class="tabular-nums text-fg-3">3</span>');
  });
});

describe('Chip onClear', () => {
  it('unset: the chip renders exactly as before (no wrapper, no X, no spacer)', () => {
    const html = renderToStaticMarkup(<Chip label="Open" selected />);
    expect(html.startsWith('<button')).toBe(true);
    expect(html).not.toContain('data-chip-clear');
    expect(html).not.toContain('aria-hidden');
  });

  it('set: a sibling outlined Clear pill labelled "Clear <label> filter", no X', () => {
    const html = renderToStaticMarkup(<Chip label="Photos" selected onClear={() => undefined} />);
    expect(html.startsWith('<span data-chip-clearable')).toBe(true);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    // Never a button inside a button: the chip closes before Clear opens.
    expect(html.indexOf('</button>')).toBeLessThan(html.lastIndexOf('<button'));
    const clear = buttons[1] ?? '';
    expect(clear).toContain('aria-label="Clear Photos filter"');
    expect(clear).toContain('data-chip-clear');
    // The shared ClearButton: a Tool, the word on a 44 tall ghost box, no
    // outline, so it never reads as a second chip.
    expect(clear).toContain('h-11 min-h-11 min-w-11');
    expect(clear).not.toContain('rounded-full');
    expect(clear).toContain('data-clear-button');
    expect(html).toMatch(/>Clear<\/button><\/span>$/);
    expect(html).not.toContain('<svg');
    // The chip keeps its selected look, with no reserved glyph spacer.
    expect(html).toContain('border-fg text-fg');
    expect(buttons[0]).toContain('min-h-11');
    expect(html).toContain('min-h-9 px-4 compact:min-h-8 compact:px-3 calm:min-h-10');
    expect(html).not.toContain('w-4 shrink-0');
  });
});

describe('Chip visible by density (36 Cozy, 32 Compact, 40 Calm), 44 tap box', () => {
  it('the button is the transparent 44 box; the face is the density chip (16 side padding, 12 in Compact), text-md', () => {
    for (const size of ['sm', 'tap'] as const) {
      const html = renderToStaticMarkup(<Chip label="Open" size={size} selected={false} />);
      const button = /<button[^>]*>/.exec(html)?.[0] ?? '';
      expect(button).toContain('min-h-11 min-w-11');
      // The box is a full pill like the face but draws nothing.
      expect(button).toContain('rounded-full');
      expect(button).not.toContain('rounded-lg');
      expect(button).not.toMatch(/\b(bg-|lit-well|lit-pill|lit-hover|border|px-)/);
      expect(button).toContain('[&amp;:focus-visible&gt;span]:lit-focus');
      const face = /<span data-chip-face=""[^>]*>/.exec(html)?.[0] ?? '';
      expect(face).toContain('min-h-9 px-4 compact:min-h-8 compact:px-3 calm:min-h-10');
      expect(face).toContain('rounded-full');
      expect(face).not.toContain('rounded-lg');
      expect(face).toContain('text-md font-medium');
      expect(face).toContain('gap-2');
      expect(face).toContain('border text-md font-medium lit-hover');
      expect(face).toContain('border-border-strong text-fg-2');
      expect(face).not.toMatch(/bg-panel-3|lit-well-soft/);
      expect(face).not.toContain('text-base');
    }
    expect(renderToStaticMarkup(<Chip label="Open" size="tap" />)).toMatch(
      /data-chip-face=""[^>]*justify-center/,
    );
  });

  it('the add chip is a plain "+" pill: the rest hairline, fg ink, no dashed box, flat (no lit-chip)', () => {
    const html = renderToStaticMarkup(<Chip label="Add" variant="add" />);
    const face = /<span data-chip-face=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(face).toContain('border-border-strong text-fg');
    expect(face).not.toContain('border-dashed');
    expect(face).not.toContain('lit-chip');
  });

  it('a call site className reaches the face; only layout classes reach the tap box', () => {
    const html = renderToStaticMarkup(
      <Chip label="Due" className="min-w-0 flex-auto justify-center truncate px-2" />,
    );
    const button = /<button[^>]*>/.exec(html)?.[0] ?? '';
    expect(button).toContain('min-w-0 flex-auto');
    expect(button).not.toContain('px-2');
    expect(button).not.toContain('truncate');
    const face = /<span data-chip-face=""[^>]*>/.exec(html)?.[0] ?? '';
    const faceTokens = (/class="([^"]*)"/.exec(face)?.[1] ?? '').split(' ');
    expect(faceTokens).toContain('px-2');
    // The call site's px-2 replaces the Cozy px-4 (twMerge); the density
    // variants are a separate group and stay.
    expect(faceTokens).not.toContain('px-4');
    expect(faceTokens).not.toContain('px-3');
    expect(face).toContain('truncate');
  });
});

describe('Chip edges (8 Nov 2026): rest on the strong edge, picked on the ink line', () => {
  const faceClass = (html: string): string[] =>
    (/<span data-chip-face=""[^>]*class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ');

  it('the exported edges', () => {
    expect(CHIP_REST_EDGE).toBe('border-border-strong text-fg-2');
    expect(CHIP_PICKED_EDGE).toBe('border-fg text-fg');
    expect(CHIP_FACE_SIZE).toBe('min-h-9 px-4 compact:min-h-8 compact:px-3 calm:min-h-10');
  });

  it('rest: border-border-strong in fg-2, never the plain hairline, no fill', () => {
    for (const html of [
      renderToStaticMarkup(<Chip label="Open" />),
      renderToStaticMarkup(<Chip label="Open" selected={false} />),
      renderToStaticMarkup(<Chip label="Open" size="tap" selected={false} />),
    ]) {
      const face = faceClass(html);
      expect(face).toEqual(expect.arrayContaining(['border', 'border-border-strong', 'text-fg-2']));
      expect(face).not.toContain('border-border');
      expect(face).not.toContain('border-fg');
      expect(face.filter((c) => c.startsWith('bg-'))).toEqual([]);
    }
  });

  it('picked: the ink line border-fg in fg, no fill, no strong edge', () => {
    for (const html of [
      renderToStaticMarkup(<Chip label="Open" selected />),
      renderToStaticMarkup(<Chip label="Open" tab selected />),
      renderToStaticMarkup(<Chip label="Open" size="tap" selected />),
    ]) {
      const face = faceClass(html);
      expect(face).toEqual(expect.arrayContaining(['border', 'border-fg', 'text-fg']));
      expect(face).not.toContain('border-border-strong');
      expect(face).not.toContain('text-fg-2');
      expect(face.filter((c) => c.startsWith('bg-'))).toEqual([]);
    }
  });

  it("the 'add' variant: solid strong hairline in fg ink, selected or not", () => {
    for (const selected of [undefined, false, true]) {
      const face = faceClass(
        renderToStaticMarkup(
          <Chip label="Add" variant="add" {...(selected !== undefined ? { selected } : {})} />,
        ),
      );
      expect(face).toEqual(expect.arrayContaining(['border-border-strong', 'text-fg']));
      expect(face).not.toContain('border-dashed');
      expect(face).not.toContain('text-fg-2');
      expect(face).not.toContain('border-fg');
    }
  });

  it("size 'tap' centres the label in its cell; the face size follows the density", () => {
    const tap = faceClass(renderToStaticMarkup(<Chip label="Cozy" size="tap" />));
    expect(tap).toEqual(
      expect.arrayContaining([
        'justify-center',
        'text-center',
        'min-h-9',
        'compact:min-h-8',
        'calm:min-h-10',
      ]),
    );
    const sm = faceClass(renderToStaticMarkup(<Chip label="Cozy" />));
    expect(sm).not.toContain('text-center');
  });
});
