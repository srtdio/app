// Chip announces its own state: aria-pressed on a toggle chip, role="tab" +
// aria-selected on a tab chip, neither on an action chip.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Chip, chipStateAria } from '@/components/ui/Chip';

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
    expect(idle).toContain('border-border text-fg-2');
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

  it('set: a sibling ghost "Clear" Button labelled "Clear <label> filter", no X', () => {
    const html = renderToStaticMarkup(<Chip label="Photos" selected onClear={() => undefined} />);
    expect(html.startsWith('<span data-chip-clearable')).toBe(true);
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    // Never a button inside a button: the chip closes before Clear opens.
    expect(html.indexOf('</button>')).toBeLessThan(html.lastIndexOf('<button'));
    const clear = buttons[1] ?? '';
    expect(clear).toContain('aria-label="Clear Photos filter"');
    expect(clear).toContain('data-chip-clear');
    // The shared ghost Button: 44 tall tap area, quiet ink.
    expect(clear).toContain('h-11 min-h-11 min-w-11');
    expect(clear).toContain('lit-hover text-fg-2');
    expect(html).toMatch(/>Clear<\/button><\/span>$/);
    expect(html).not.toContain('<svg');
    // The chip keeps its selected look, with no reserved glyph spacer.
    expect(html).toContain('border-fg text-fg');
    expect(buttons[0]).toContain('min-h-11');
    expect(html).toContain('min-h-8 px-3');
    expect(html).not.toContain('w-4 shrink-0');
  });
});

describe('Chip 32 visible, 44 tap box', () => {
  it('the button is the transparent 44 box; the face is the 32 chip, 12 side padding, text-md', () => {
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
      expect(face).toContain('min-h-8 px-3');
      expect(face).toContain('rounded-full');
      expect(face).not.toContain('rounded-lg');
      expect(face).toContain('text-md font-medium');
      expect(face).toContain('gap-2');
      expect(face).not.toContain('gap-2');
      expect(face).toContain('border text-md font-medium lit-hover');
      expect(face).toContain('border-border text-fg-2');
      expect(face).not.toMatch(/bg-panel-3|lit-well-soft/);
      expect(face).not.toContain('text-base');
    }
    expect(renderToStaticMarkup(<Chip label="Open" size="tap" />)).toMatch(
      /data-chip-face=""[^>]*justify-center/,
    );
  });

  it('the add chip keeps its dashed edge on the face, flat (no lit-chip)', () => {
    const html = renderToStaticMarkup(<Chip label="Add" variant="add" />);
    const face = /<span data-chip-face=""[^>]*>/.exec(html)?.[0] ?? '';
    expect(face).toContain('border-dashed border-border-strong text-fg-3');
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
    expect(face).toContain('px-2');
    expect(face).not.toContain('px-3');
    expect(face).toContain('truncate');
  });
});
