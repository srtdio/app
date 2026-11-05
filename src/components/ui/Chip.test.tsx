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

  it('the pick is the solid ink fill and marks itself for the slide', () => {
    const toggle = renderToStaticMarkup(<Chip label="Open" selected />);
    expect(toggle).toContain('bg-accent text-accent-fg lit-pill');
    expect(toggle).toContain('data-selected="true"');
    const tab = renderToStaticMarkup(<Chip label="Open" tab selected />);
    expect(tab).toContain('bg-accent text-accent-fg lit-pill');
    const idle = renderToStaticMarkup(<Chip label="Open" selected={false} />);
    expect(idle).toContain('bg-panel-3 text-fg lit-well-soft');
    expect(idle).not.toContain('data-selected');
  });
});
