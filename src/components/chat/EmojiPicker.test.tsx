import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMOJI_NO_RESULTS,
  EMOJI_ROW_BUFFER,
  EMOJI_ROW_PX,
  EmojiGrid,
  EmojiSearchField,
  EmojiTabs,
  EmojiVirtualGrid,
  activeGroupAfterQuery,
  activeGroupAfterScroll,
  createEmojiSearch,
  emojiRows,
  emojiSections,
  groupAtRow,
  groupRowIndex,
  gridColumns,
  gridRows,
  renderedRowIndices,
  searchEmoji,
  tabJumpTop,
  visibleRowRange,
} from '@/components/chat/EmojiPicker';
import { EMOJI, EMOJI_GROUPS } from '@/components/chat/emoji-data';
import {
  EMOJI_LOAD_FAILED,
  EmojiPickerLoadFailed,
  loadEmojiPicker,
  pickerBodyState,
  popoverPosition,
  resetEmojiPickerLoad,
  type EmojiPickerModule,
} from '@/components/chat/MessageActionMenu';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function all(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const out: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!isValidElement(n)) return;
    out.push(n as ReactElement<Record<string, unknown>>);
    walk((n.props as { children?: ReactNode }).children);
  };
  walk(node);
  return out;
}

/** Expand the hook-free EmojiButton children so their buttons show up. */
function buttons(node: ReactElement): ReactElement<Record<string, unknown>>[] {
  return all(node).flatMap((el) => {
    if (typeof el.type === 'function') {
      return buttons((el.type as (p: unknown) => ReactElement)(el.props));
    }
    return el.type === 'button' ? [el] : [];
  });
}

describe('emoji data (Unicode 15.0, generated)', () => {
  it('has fully-qualified emoji with char, name and group, no skin-tone or hair variants', () => {
    expect(EMOJI.length).toBeGreaterThan(1800);
    const chars = new Set(EMOJI.map((e) => e.char));
    expect(chars.size).toBe(EMOJI.length);
    for (const tone of ['🏻', '🏼', '🏽', '🏾', '🏿']) {
      expect(EMOJI.some((e) => e.char.includes(tone))).toBe(false);
    }
    expect(EMOJI.some((e) => /skin tone|red hair|curly hair|white hair|bald/.test(e.name))).toBe(
      false,
    );
    expect(EMOJI.find((e) => e.char === '👍')).toEqual({
      char: '👍',
      name: 'thumbs up',
      group: 'People & Body',
    });
    expect(EMOJI_GROUPS).not.toContain('Component');
  });
});

describe('searchEmoji', () => {
  it('matches the CLDR short name, every word, any case', () => {
    expect(searchEmoji('unicorn').map((e) => e.char)).toEqual(['🦄']);
    expect(searchEmoji('Tears JOY').map((e) => e.char)).toContain('😂');
    expect(searchEmoji('heart red').map((e) => e.char)).toContain('❤️');
    expect(searchEmoji('   ')).toEqual([]);
    expect(searchEmoji('zzqx')).toEqual([]);
  });
});

describe('EmojiPicker parts', () => {
  it('search on top: a real input, never under 16px on touch', () => {
    const onQuery = vi.fn();
    const field = EmojiSearchField({ query: '', onQuery, layout: 'touch' });
    const input = all(field).find((e) => e.type === 'input');
    expect(String(input?.props.className)).toContain('text-[17px]');
    (input?.props.onChange as (e: { target: { value: string } }) => void)({
      target: { value: 'cat' },
    });
    expect(onQuery).toHaveBeenCalledWith('cat');
  });

  it('one 44x44 tab per Unicode group; a tap goes to that group', () => {
    const onTab = vi.fn();
    const tabs = EmojiTabs({ query: '', activeGroup: 'Smileys & Emotion', onTab });
    // Each tab is an IconButton: expand it to the <button> it renders.
    const list = buttons(tabs).filter((e) => e.props.role === 'tab');
    expect(list.map((t) => t.props['aria-label'])).toEqual(emojiSections().map((s) => s.group));
    for (const t of list) expect(String(t.props.className)).toContain('h-11 w-11');
    (list[3]?.props.onClick as () => void)();
    expect(onTab).toHaveBeenCalledWith(emojiSections()[3]?.group);
  });

  it('search by name shows only the matches; a pick hands the glyph back once', () => {
    const onPick = vi.fn();
    const grid = EmojiGrid({
      rows: gridRows('unicorn', 8, searchEmoji, emojiRows(emojiSections(), 8)),
      onPick,
      scrollTop: 0,
      viewportHeight: 400,
    });
    const found = buttons(grid);
    expect(found.map((b) => b.props['aria-label'])).toEqual(['unicorn']);
    expect(String(found[0]?.props.className)).toContain('h-11 w-11');
    (found[0]?.props.onClick as () => void)();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith('🦄');
  });

  it('no match: the empty line', () => {
    const grid = EmojiGrid({
      rows: gridRows('zzqx', 8, searchEmoji, emojiRows(emojiSections(), 8)),
      onPick: vi.fn(),
      scrollTop: 0,
      viewportHeight: 400,
    });
    expect(all(grid).some((e) => e.props.children === EMOJI_NO_RESULTS)).toBe(true);
  });

  it('the laptop popover sits above the menu when there is room, else below, inside the viewport', () => {
    const viewport = { width: 1280, height: 800 };
    expect(popoverPosition({ top: 600, bottom: 700, left: 100 }, viewport)).toEqual({
      top: 192,
      left: 100,
    });
    expect(popoverPosition({ top: 100, bottom: 200, left: 1200 }, viewport)).toEqual({
      top: 208,
      left: 920,
    });
  });
});

describe('F3: the virtualized grid', () => {
  const sections = emojiSections();

  it('fixed 44px rows: a heading per group, then its glyphs in lines of the column count', () => {
    const rows = emojiRows(sections, 8);
    expect(EMOJI_ROW_PX).toBe(44);
    expect(rows[0]).toEqual({ kind: 'heading', group: 'Smileys & Emotion' });
    expect(rows[1]?.kind === 'glyphs' && rows[1].emojis.length).toBe(8);
    const glyphs = rows.flatMap((r) => (r.kind === 'glyphs' ? r.emojis : []));
    expect(glyphs).toHaveLength(EMOJI.length);
    expect(gridColumns(352)).toBe(7);
  });

  it('renders only the visible rows plus a 3-row buffer', () => {
    const rows = emojiRows(sections, 8);
    expect(rows.length).toBeGreaterThan(200);
    // 400px tall window scrolled to row 100.
    const range = visibleRowRange(100 * EMOJI_ROW_PX, 400, rows.length);
    expect(range).toEqual({ start: 100 - EMOJI_ROW_BUFFER, end: 100 + 11 + EMOJI_ROW_BUFFER });
    const grid = EmojiVirtualGrid({
      rows,
      scrollTop: 100 * EMOJI_ROW_PX,
      viewportHeight: 400,
      onPick: vi.fn(),
    });
    const rendered = all(grid).filter((e) => e.props['data-emoji-row'] !== undefined);
    expect(rendered).toHaveLength(range.end - range.start);
    expect(rendered[0]?.props['data-emoji-row']).toBe(97);
    // The spacer is as tall as every row, so the scrollbar is true.
    expect((grid.props.style as { height: number }).height).toBe(rows.length * EMOJI_ROW_PX);
    // The top of the list: no negative rows.
    expect(visibleRowRange(0, 400, rows.length).start).toBe(0);
  });

  it('a group tab jumps by row index; the tab follows the group at the top', () => {
    const rows = emojiRows(sections, 8);
    const index = groupRowIndex(rows);
    const flags = index.get('Flags') ?? -1;
    expect(rows[flags]).toEqual({ kind: 'heading', group: 'Flags' });
    expect(groupAtRow(rows, flags)).toBe('Flags');
    expect(groupAtRow(rows, flags - 1)).not.toBe('Flags');
  });
});

describe('F3: EmojiPicker and emoji-data are not in the main chunk', () => {
  // Walk the static import graph from the app entry; dynamic import() edges
  // are chunk boundaries and are not followed.
  const root = fileURLToPath(new URL('../../', import.meta.url));
  function resolve(from: string, spec: string): string | null {
    const base = spec.startsWith('@/')
      ? join(root, spec.slice(2))
      : spec.startsWith('.')
        ? join(dirname(from), spec)
        : null;
    if (base === null) return null;
    for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
      if (existsSync(base + ext) && !base.endsWith('/') && (ext !== '' || /\.tsx?$/.test(base))) {
        return base + ext;
      }
    }
    return null;
  }
  function staticGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    const importRe =
      /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(importRe)) {
        if (/^\s*(?:import|export)\s+type\s/.test(match[0].trim())) continue;
        const next = resolve(file, match[1] ?? '');
        if (next !== null) queue.push(next);
      }
    }
    return seen;
  }

  it('the app entry reaches the menu statically but never the picker body or its data', () => {
    // App.tsx is the root of the app chunk since main.tsx loads it dynamically (homepage fast guest path).
    const graph = staticGraph(join(root, 'App.tsx'));
    expect(graph.has(join(root, 'components/chat/MessageActionMenu.tsx'))).toBe(true);
    expect(graph.has(join(root, 'components/chat/EmojiPicker.tsx'))).toBe(false);
    expect(graph.has(join(root, 'components/chat/emoji-data.ts'))).toBe(false);
  });

  it('the menu loads the picker through a dynamic import()', () => {
    const menu = readFileSync(join(root, 'components/chat/MessageActionMenu.tsx'), 'utf8');
    expect(menu).toContain("import('@/components/chat/EmojiPicker')");
  });
});

describe('F15: the emoji data generator is typechecked and linted', () => {
  const repo = fileURLToPath(new URL('../../../', import.meta.url));

  it('scripts/tsconfig.json (run by the scripts typecheck CI on every PR) includes the script', () => {
    const config = JSON.parse(readFileSync(join(repo, 'scripts/tsconfig.json'), 'utf8')) as {
      include: string[];
    };
    expect(config.include).toContain('./gen-emoji-data.ts');
  });

  it('the eslint config lints every .ts file and does not ignore scripts/', () => {
    const eslint = readFileSync(join(repo, 'eslint.config.js'), 'utf8');
    expect(eslint).toContain("files: ['**/*.{ts,tsx}']");
    expect(eslint).not.toMatch(/ignores:[^\]]*scripts/);
  });
});

describe('R3: the picker chunk fails to load', () => {
  afterEach(() => resetEmojiPickerLoad());

  it('shows the copy and a 44x44 Try again, never the raw error, and is not busy', () => {
    const onRetry = vi.fn();
    const html = renderToStaticMarkup(<EmojiPickerLoadFailed onRetry={onRetry} />);
    // The markup escapes the apostrophe; the line itself is the fixed copy.
    const line = all(EmojiPickerLoadFailed({ onRetry })).find((e) => e.type === 'p');
    expect(line?.props.children).toBe(EMOJI_LOAD_FAILED);
    expect(EMOJI_LOAD_FAILED).toBe("Couldn't load emoji. Try again.");
    expect(html).toContain('Try again');
    expect(html).toMatch(/h-11[^"]*min-w-\[44px\]|min-w-\[44px\][^"]*h-11/);
    expect(html).not.toContain('chunk');
    const el = EmojiPickerLoadFailed({ onRetry });
    const retry = all(el).find((e) => e.props['data-emoji-retry'] !== undefined);
    (retry?.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(pickerBodyState(null, true)).toBe('failed');
    expect(pickerBodyState(null, false)).toBe('loading');
  });

  it('Try again re-runs the import; its success fills the grid', async () => {
    const failing = vi.fn(() => Promise.reject(new Error('chunk 404')));
    await expect(loadEmojiPicker(failing)).rejects.toThrow();
    const module = { EmojiPickerPanel: () => null } as unknown as EmojiPickerModule;
    const working = vi.fn(() => Promise.resolve(module));
    const loaded = await loadEmojiPicker(working);
    expect(working).toHaveBeenCalledOnce();
    expect(pickerBodyState(loaded, false)).toBe('ready');
  });
});

describe('R4: a tab tap while searching', () => {
  const rows = emojiRows(emojiSections(), 8);
  const index = groupRowIndex(rows);

  it('lands on the tapped group with its tab highlighted', () => {
    const top = tabJumpTop('Flags', index);
    expect(top).toBe((index.get('Flags') ?? -1) * EMOJI_ROW_PX);
    // The jump's own scroll (even clamped at the end of the list) keeps the tapped tab.
    expect(
      activeGroupAfterScroll({
        rows,
        scrollTop: top - 3 * EMOJI_ROW_PX,
        searching: false,
        jumpTop: top - 3 * EMOJI_ROW_PX,
        current: 'Flags',
      }),
    ).toBe('Flags');
    // With the query cleared the tab reads selected.
    const tabs = buttons(EmojiTabs({ query: '', activeGroup: 'Flags', onTab: vi.fn() })).filter(
      (e) => e.props.role === 'tab',
    );
    const selected = tabs.filter((t) => t.props['aria-selected'] === true);
    expect(selected.map((t) => t.props['aria-label'])).toEqual(['Flags']);
    // A later user scroll follows the group at the top again.
    expect(
      activeGroupAfterScroll({
        rows,
        scrollTop: 0,
        searching: false,
        jumpTop: top,
        current: 'Flags',
      }),
    ).toBe('Smileys & Emotion');
  });
});

describe('R4b: clearing the query by typing', () => {
  it('resets the highlighted tab to the first group', () => {
    const first = emojiSections()[0]?.group ?? null;
    // Scrolled to Flags, then typed a query: the highlight stays while searching.
    expect(activeGroupAfterQuery({ query: 'cat', pendingTab: null, current: 'Flags', first })).toBe(
      'Flags',
    );
    // Backspaced to empty: the grid is at the top, so the first group reads selected.
    expect(activeGroupAfterQuery({ query: '', pendingTab: null, current: 'Flags', first })).toBe(
      first,
    );
    // A tab tap that cleared the query keeps the tapped group.
    expect(
      activeGroupAfterQuery({ query: '', pendingTab: 'Travel & Places', current: 'Flags', first }),
    ).toBe('Travel & Places');
  });
});

describe('R5: picker perf and focus', () => {
  it('search is memoized per query: scroll renders never re-run it', () => {
    const spy = vi.fn(searchEmoji);
    const search = createEmojiSearch(spy);
    const sections = emojiRows(emojiSections(), 8);
    const first = gridRows('cat', 8, search, sections);
    gridRows('cat', 8, search, sections);
    gridRows('Cat ', 8, search, sections);
    expect(spy).toHaveBeenCalledOnce();
    expect(search('cat')).toBe(search('cat'));
    gridRows('dog', 8, search, sections);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(first).not.toBeNull();
  });

  it('the focused row stays rendered after it scrolls out of the window', () => {
    const rows = emojiRows(emojiSections(), 8);
    expect(renderedRowIndices({ start: 50, end: 60 }, 2, rows.length)[0]).toBe(2);
    expect(renderedRowIndices({ start: 50, end: 60 }, 99, rows.length).at(-1)).toBe(99);
    expect(renderedRowIndices({ start: 50, end: 60 }, 55, rows.length)).toHaveLength(10);
    expect(renderedRowIndices({ start: 50, end: 60 }, null, rows.length)).toHaveLength(10);
    const grid = EmojiVirtualGrid({
      rows,
      scrollTop: 100 * EMOJI_ROW_PX,
      viewportHeight: 400,
      onPick: vi.fn(),
      keepRow: 1,
    });
    const rendered = all(grid)
      .filter((e) => e.props['data-emoji-row'] !== undefined)
      .map((e) => e.props['data-emoji-row']);
    expect(rendered).toContain(1);
    expect(rendered).toContain(100);
  });
});
