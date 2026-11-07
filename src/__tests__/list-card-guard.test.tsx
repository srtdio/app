// Guard (locked 7 Nov 2026, CLAUDE.md "List card" / "No ⋮ on a list card"):
// 1. No ListCard caller passes a menu: no `menu` / `check` prop on <ListCard>,
//    and no ActionMenu / ActionMenuTrigger / ⋮ glyph inside a <ListCard>'s
//    props. A card's actions live on its list's select bar (ui/SelectBar).
// 2. Every row is 60 tall (flat look, 7 Nov 2026): the frame is h-15, the 40
//    picture centred in it (10 above and below), the two 20 text lines (and
//    the 2 between, 42) inside the 40 + padding. The frame is flat: no border,
//    no radius, no lit height, no clip; it bleeds -mx-4 / px-4 so the selected
//    and pressed fill runs edge to edge.
//    The real measure runs in e2e/visual/layout-checks.ts (listCardHeight).
// 3. Line 2 (follow-up, 7 Nov 2026): with a preview it reads preview, tag,
//    unread dot; with no preview the tag sits on the right end, right under
//    the time (a spacer leads), the unread dot after it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ListCard,
  ListCardBox,
  LIST_CARD_HEIGHT_PX,
  listCardFrame,
  type ListCardProps,
} from '@/components/ui/ListCard';
import { IconBriefs } from '@/components/ui/icons';
import tailwindConfig from '../../tailwind.config';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });
}

const BANNED_PROPS = new Set(['menu', 'check']);
const BANNED_NAMES = /^(ActionMenu|ActionMenuTrigger|IconMore|IconDots|IconEllipsis\w*)$/;

/** Offences inside every <ListCard ...> in one file: "file:line what". */
function offences(path: string): string[] {
  const text = readFileSync(path, 'utf8');
  if (!text.includes('<ListCard')) return [];
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const where = (node: ts.Node): string =>
    `${relative(SRC, path).split(sep).join('/')}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      node.tagName.getText(file) === 'ListCard'
    ) {
      for (const attr of node.attributes.properties) {
        if (ts.isJsxAttribute(attr) && BANNED_PROPS.has(attr.name.getText(file))) {
          out.push(`${where(attr)} passes ${attr.name.getText(file)}`);
        }
        const scan = (inner: ts.Node): void => {
          if (ts.isIdentifier(inner) && BANNED_NAMES.test(inner.text)) {
            out.push(`${where(inner)} puts ${inner.text} on a ListCard`);
          }
          if (ts.isStringLiteral(inner) && inner.text.includes('⋮')) {
            out.push(`${where(inner)} puts a ⋮ on a ListCard`);
          }
          ts.forEachChild(inner, scan);
        };
        scan(attr);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

describe('guard: no ListCard caller passes a menu', () => {
  const callers = sourceFiles(SRC).filter(
    (path) =>
      readFileSync(path, 'utf8').includes('<ListCard') &&
      !path.endsWith(join('ui', 'ListCard.tsx')),
  );

  it('finds the list callers (Pipeline, Briefs, Assets, Chat, Plan tab, Bank, Activity)', () => {
    const names = callers.map((path) => relative(SRC, path).split(sep).join('/'));
    for (const caller of [
      'components/pages/PostCard.tsx',
      'components/pages/BriefCard.tsx',
      'components/pages/assets/AssetListCard.tsx',
      'components/chat/ChannelList.tsx',
      'components/pages/plan-tab/PlanTabList.tsx',
      'components/pages/plan-tab/BankList.tsx',
      'components/pages/activity/ActivityCard.tsx',
    ]) {
      expect(names).toContain(caller);
    }
  });

  it('no menu / check prop, no ActionMenu, ActionMenuTrigger or ⋮ inside a ListCard', () => {
    expect(callers.flatMap(offences)).toEqual([]);
  });

  it('ListCard itself has no menu or check prop and no trailing ⋮ slot', () => {
    const part = readFileSync(join(SRC, 'components/ui/ListCard.tsx'), 'utf8');
    expect(part).not.toMatch(/^\s+menu\?:/m);
    expect(part).not.toMatch(/^\s+check\?:/m);
    expect(part).not.toContain('data-list-card-more');
    expect(part).not.toContain('ActionMenu');
  });
});

/** The class list of the first element carrying `attr`. */
const cls = (html: string, attr: string): string[] =>
  (new RegExp(`<[a-z]+[^>]*${attr}[^>]*class="([^"]*)"`).exec(html)?.[1] ?? '').split(' ');
const pick = (list: string[], re: RegExp): string => list.find((c) => re.test(c)) ?? '';

describe('guard: every row is 60 tall', () => {
  const spacing = tailwindConfig.theme?.spacing as Record<string, string>;
  const px = (token: string, prefix: string): number =>
    parseFloat(spacing[token.slice(prefix.length)] ?? 'NaN') * 16;

  /** The row height from the rendered classes: the frame's own h-N, never smaller than its content. */
  function measured(html: string): number {
    const frame = px(pick(cls(html, 'data-list-card=""'), /^h-\d/), 'h-');
    const picture = px(pick(cls(html, 'data-list-card-picture='), /^h-\d/), 'h-');
    const line1 = px(pick(cls(html, 'data-list-card-line="1"'), /^h-\d/), 'h-');
    const line2 = px(pick(cls(html, 'data-list-card-line="2"'), /^h-\d/), 'h-');
    const text = line1 + 2 + line2;
    // The 40 picture sits 10 below the top and 10 above the bottom; the 42 text
    // column (20 + 2 + 20) centres against it and still fits the frame.
    expect(picture + 10 + 10).toBe(frame);
    expect(text).toBeLessThanOrEqual(frame);
    return frame;
  }

  const base: ListCardProps = {
    picture: { kind: 'icon', icon: IconBriefs },
    title: 'Spring launch',
    onPress: () => {},
  };
  const variants: Record<string, Partial<ListCardProps>> = {
    full: {
      preview: 'Tease the drop',
      time: '2d late',
      timeBad: true,
      tag: 'Review',
      tagDot: 'review',
      unread: true,
    },
    'no preview': { time: 'Fri', tag: 'Open' },
    'no tag, no preview': { time: '3h' },
    'long preview': { preview: 'x'.repeat(500), tag: 'Draft' },
    person: { picture: { kind: 'person', name: 'Priya Shah' }, preview: 'Hi' },
    'select mode, chosen': {
      select: { active: true, chosen: true, onEnter: () => {}, onToggle: () => {} },
    },
    selected: { selected: true, preview: 'Hi' },
    muted: { muted: true, preview: 'Closed' },
  };

  for (const [name, over] of Object.entries(variants)) {
    it(`${name}: 60`, () => {
      expect(measured(renderToStaticMarkup(<ListCard {...base} {...over} />))).toBe(
        LIST_CARD_HEIGHT_PX,
      );
    });
  }

  it('LIST_CARD_HEIGHT_PX is 60 and the skeleton keeps the same frame and picture', () => {
    expect(LIST_CARD_HEIGHT_PX).toBe(60);
    const box = renderToStaticMarkup(<ListCardBox />);
    expect(cls(box, 'data-list-card-box=""')).toContain('h-15');
    expect(box).toContain('h-10 w-10');
    expect(box).not.toContain('h-12 w-12');
  });
});

describe('guard: the row frame is flat (no border, radius, lit or clip; bled 16)', () => {
  for (const [name, frame] of [
    ['listCardFrame()', listCardFrame()],
    ['listCardFrame(true)', listCardFrame(true)],
  ] as const) {
    it(`${name}: no border, rounded, lit- or overflow-hidden; -mx-4 px-4 h-15`, () => {
      const tokens = frame.split(/\s+/).filter(Boolean);
      expect(
        tokens.filter((t) => /border/.test(t)),
        name,
      ).toEqual([]);
      expect(
        tokens.filter((t) => /rounded/.test(t)),
        name,
      ).toEqual([]);
      expect(
        tokens.filter((t) => /lit-/.test(t)),
        name,
      ).toEqual([]);
      expect(tokens, name).not.toContain('overflow-hidden');
      expect(tokens, name).toEqual(expect.arrayContaining(['-mx-4', 'px-4', 'h-15']));
    });
  }

  it('selected is the panel-2 fill, never an outline', () => {
    expect(listCardFrame(true).split(/\s+/)).toContain('bg-panel-2');
    expect(listCardFrame(false).split(/\s+/)).not.toContain('bg-panel-2');
  });

  it('the rendered row (every state) carries the same flat frame', () => {
    const base: ListCardProps = { picture: { kind: 'icon', icon: IconBriefs }, title: 'T' };
    for (const over of [{}, { selected: true }, { muted: true }] as Partial<ListCardProps>[]) {
      const frame = cls(
        renderToStaticMarkup(<ListCard {...base} {...over} />),
        'data-list-card=""',
      );
      expect(frame.filter((t) => /^(border|rounded|lit-|overflow-hidden$)/.test(t))).toEqual([]);
      expect(frame).toEqual(expect.arrayContaining(['-mx-4', 'px-4', 'h-15']));
    }
  });
});

describe('guard: line 2 tag position', () => {
  const base: ListCardProps = {
    picture: { kind: 'icon', icon: IconBriefs },
    title: 'Spring launch',
    time: 'Fri',
    tag: 'Open',
    unread: true,
    onPress: () => {},
  };
  /** Line 2's children in order, by their data hooks. */
  function line2(html: string): string[] {
    const line = html.slice(html.indexOf('data-list-card-line="2"'));
    return [...line.matchAll(/data-list-card-(preview|spacer|tag|unread)=""/g)].map(
      (m) => m[1] ?? '',
    );
  }

  it('with a preview: preview, tag, unread dot (no spacer)', () => {
    const html = renderToStaticMarkup(<ListCard {...base} preview="Tease the drop" />);
    expect(line2(html)).toEqual(['preview', 'tag', 'unread']);
  });

  it('no preview: the spacer leads, the tag sits on the right end under the time', () => {
    for (const preview of [undefined, '']) {
      const html = renderToStaticMarkup(<ListCard {...base} preview={preview} />);
      expect(line2(html)).toEqual(['spacer', 'tag', 'unread']);
    }
  });
});
