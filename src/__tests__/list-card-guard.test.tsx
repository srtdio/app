// Guard (locked 7 Nov 2026, CLAUDE.md "List card" / "No ⋮ on a list card"):
// 1. No ListCard caller passes a menu: no `menu` / `check` prop on <ListCard>,
//    and no ActionMenu / ActionMenuTrigger / ⋮ glyph inside a <ListCard>'s
//    props. A card's actions live on its list's select bar (ui/SelectBar).
// 2. Every card is 74 tall: border 1 + padding + the 48 picture + padding +
//    border 1, with the two 20 text lines (and the 4 between) inside the 48.
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

describe('guard: every card is 74 tall', () => {
  const spacing = tailwindConfig.theme?.spacing as Record<string, string>;
  const px = (cls: string, prefix: string): number =>
    parseFloat(spacing[cls.slice(prefix.length)] ?? 'NaN') * 16;

  /** The card height from the rendered classes: border + padding + max(picture, text) + padding + border. */
  function measured(html: string): number {
    const cls = (attr: string): string[] =>
      (new RegExp(`<[a-z]+[^>]*${attr}[^>]*class="([^"]*)"`).exec(html)?.[1] ?? '').split(' ');
    const pick = (list: string[], re: RegExp): string => list.find((c) => re.test(c)) ?? '';
    const pad = px(pick(cls('data-list-card-body=""'), /^p-\d/), 'p-');
    const picture = px(pick(cls('data-list-card-picture='), /^h-\d/), 'h-');
    const line1 = px(pick(cls('data-list-card-line="1"'), /^h-\d/), 'h-');
    const line2 = px(pick(cls('data-list-card-line="2"'), /^h-\d/), 'h-');
    const text = line1 + 4 + line2;
    const border = cls('data-list-card=""').includes('border') ? 1 : 0;
    return border + pad + Math.max(picture, text) + pad + border;
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
  };

  for (const [name, over] of Object.entries(variants)) {
    it(`${name}: 74`, () => {
      expect(measured(renderToStaticMarkup(<ListCard {...base} {...over} />))).toBe(
        LIST_CARD_HEIGHT_PX,
      );
    });
  }

  it('LIST_CARD_HEIGHT_PX is 74 and the skeleton keeps the same body and picture', () => {
    expect(LIST_CARD_HEIGHT_PX).toBe(74);
    const box = renderToStaticMarkup(<ListCardBox />);
    expect(box).toContain('p-3');
    expect(box).toContain('h-12 w-12');
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
