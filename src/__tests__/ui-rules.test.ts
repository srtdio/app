import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// PR B rules for screens and actions: one ⋯ menu, one toast system, one sheet
// header, one delete rule, one undo window, one New button. Reads every
// src/components/**/*.tsx except home/ (marketing pages) and test-site/ (a
// staff-only harness), test files, and ui/icons.tsx (where the icons live).
const ROOT = fileURLToPath(new URL('../components/', import.meta.url));
const SKIPPED_DIRS = ['home/', 'test-site/'];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith('.tsx') ? [path] : [];
  });
}

const FILES: { rel: string; src: string }[] = tsxFiles(ROOT)
  .map((path) => ({ path, rel: relative(ROOT, path).split(sep).join('/') }))
  .filter(
    ({ rel }) =>
      !/\.test\.tsx$/.test(rel) &&
      rel !== 'ui/icons.tsx' &&
      !SKIPPED_DIRS.some((dir) => rel.startsWith(dir)),
  )
  .map(({ path, rel }) => ({ rel, src: readFileSync(path, 'utf8') }));

/** The JSX opening tag starting at `start`, up to its closing `>` outside any `{...}`. */
function openingTag(src: string, start: number): string {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** [start, end) of the balanced `{...}` that opens at `open` (src[open] === '{'). */
function braceRange(src: string, open: number): [number, number] {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return [open, i + 1];
    }
  }
  return [open, src.length];
}

/** The whole <Tag ...>...</Tag> element at `start` (or the self-closing tag). */
function element(src: string, start: number, tag: string): string {
  const open = openingTag(src, start);
  if (open.endsWith('/>')) return open;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = start + open.length;
  let depth = 1;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index + m[0].length);
  }
  return src.slice(start);
}

/** The tag with every `{...}` emptied, so only its own attribute names remain. */
function topLevel(tag: string): string {
  let depth = 0;
  let out = '';
  for (const c of tag) {
    if (c === '{') {
      if (depth === 0) out += c;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) out += c;
    } else if (depth === 0) out += c;
  }
  return out;
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

function indexesOf(src: string, re: RegExp): number[] {
  const out: number[] = [];
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  for (let m = global.exec(src); m !== null; m = global.exec(src)) out.push(m.index);
  return out;
}

describe('ui rules: one ⋯ menu', () => {
  // IconMore is the ⋯ glyph. It renders only inside ui/ActionMenu.tsx (its
  // default trigger, ActionMenuTrigger) or inside the `trigger={...}` prop of
  // an <ActionMenu> element, so every ⋯ opens the one menu.
  it('IconMore appears only in ui/ActionMenu.tsx or inside an ActionMenu trigger', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      if (rel === 'ui/ActionMenu.tsx') continue;
      const uses = indexesOf(src, /<IconMore\b/);
      if (uses.length === 0) continue;
      const triggers: [number, number][] = [];
      for (const start of indexesOf(src, /<ActionMenu\b/)) {
        const tag = openingTag(src, start);
        const at = tag.search(/\btrigger=\{/);
        if (at === -1) continue;
        const brace = start + at + 'trigger='.length;
        triggers.push(braceRange(src, brace));
      }
      for (const use of uses) {
        if (!triggers.some(([a, b]) => use > a && use < b)) {
          offenders.push(`${rel}:${lineOf(src, use)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('ui rules: one toast system', () => {
  it('nothing imports the retired pages/assets/Toasts or useToasts', () => {
    const offenders = FILES.filter(({ src }) =>
      /from\s+['"][^'"]*(?:pages\/assets\/Toasts|\/useToasts|\.\/Toasts)['"]/.test(src),
    ).map(({ rel }) => rel);
    expect(offenders).toEqual([]);
  });
});

// ConfirmDialog is for actions that cannot come back. Anything that goes to
// Recently deleted deletes at once with an Undo strip instead. Each file that
// renders a ConfirmDialog is listed with the action(s) it guards; a new one
// needs a reason to be here.
const CONFIRM_DIALOG_ALLOWLIST: Record<string, string> = {
  // Irreversible (spec): delete forever, empty Recently deleted.
  'pages/RecentlyDeletedPage.tsx': 'Delete now (delete forever); Empty Recently deleted',
  // Irreversible (spec): remove member from the workspace.
  'pages/settings/MembersPanel.tsx': 'Remove member from the workspace',
  // Irreversible (spec): delete message for everyone (files, multi-select).
  'chat/SelectionBar.tsx': 'Delete messages for everyone (one or many, notes)',
  // Group membership: remove a member from a group, leave a group.
  'chat/GroupInfoSheet.tsx': 'Remove member from group; Leave group',
  // Hide chat clears the chat for the caller; it does not come back.
  'chat/ChannelList.tsx': 'Hide chat (clears messages for the caller)',
  // Remove an approved address from settings (no Recently deleted).
  'pages/settings/ApprovedAddressesSection.tsx': 'Remove approved address',
  // Discard confirms: unsaved input that cannot come back.
  'ui/Sheet.tsx': 'Discard changes (every dirty sheet close)',
  'pages/create/ComposerSheet.tsx': 'Discard the composed post',
  'pages/PostDetailPage.tsx': 'Discard caption changes',
  'chat/PlanComposeScreen.tsx': 'Discard a new plan',
  'chat/PlanScreen.tsx': 'Discard plan edits',
  'chat/ConceptSheet.tsx': 'Discard a concept',
  'comments/Comments.tsx': 'Discard reply',
  'chat/Composer.tsx': 'Delete or replace the saved voice draft',
  'shell/WorkspaceSwitcher.tsx': 'Switch to the approver workspace; discard a new workspace',
  'pages/assets/AssetUploadSheet.tsx': 'Stop an upload in progress',
  // Send for review again with open comments: warns, never blocks.
  'pages/pcs/use-post-decisions.tsx': 'Send anyway (open comments warning)',
};

describe('ui rules: one delete rule', () => {
  it('ConfirmDialog renders only in allowlisted files', () => {
    const users = FILES.filter(
      ({ rel, src }) => rel !== 'ui/ConfirmDialog.tsx' && /<ConfirmDialog\b/.test(src),
    ).map(({ rel }) => rel);
    expect(users.filter((rel) => !(rel in CONFIRM_DIALOG_ALLOWLIST))).toEqual([]);
  });

  it('every allowlisted file still renders a ConfirmDialog (no stale entries)', () => {
    const byRel = new Map(FILES.map(({ rel, src }) => [rel, src]));
    const stale = Object.keys(CONFIRM_DIALOG_ALLOWLIST).filter(
      (rel) => !/<ConfirmDialog\b/.test(byRel.get(rel) ?? ''),
    );
    expect(stale).toEqual([]);
  });
});

describe('ui rules: one sheet header', () => {
  // Every sheet header is title left, close X right. Cancel lives in footers,
  // so no <Sheet> takes a header Cancel prop of any name.
  it('no <Sheet> passes a header cancel prop', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const start of indexesOf(src, /<Sheet\b/)) {
        const attrs = topLevel(openingTag(src, start));
        if (
          /\b(?:cancelLabel|headerCancel|cancelText|onCancel|leftAction|headerLeft|cancel)=/.test(
            attrs,
          )
        ) {
          offenders.push(`${rel}:${lineOf(src, start)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('ui rules: one undo window', () => {
  // A file shows an Undo when it renders the strip, runs useUndoableAction, or
  // labels an action "Undo".
  const undoFiles = FILES.filter(({ src }) =>
    /UndoStrip|useUndoableAction|['"`]Undo['"`]|>\s*Undo\s*</.test(src),
  );

  it('finds the undo flows', () => {
    expect(undoFiles.length).toBeGreaterThan(0);
  });

  it('no toast durationMs is a number literal in a file that shows Undo', () => {
    const offenders: string[] = [];
    for (const { rel, src } of undoFiles) {
      for (const at of indexesOf(src, /durationMs\s*[:=]\s*\{?\s*[\d_]+/)) {
        offenders.push(`${rel}:${lineOf(src, at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no 7 s (or other literal) undo window in a file that shows Undo', () => {
    const offenders: string[] = [];
    for (const { rel, src } of undoFiles) {
      for (const at of indexesOf(src, /\b7_?000\b/)) offenders.push(`${rel}:${lineOf(src, at)}`);
    }
    expect(offenders).toEqual([]);
  });

  it('no undo constant is a number literal anywhere in components (UNDO_MS is the one)', () => {
    const offenders: string[] = [];
    for (const { rel, src } of FILES) {
      for (const at of indexesOf(src, /\b\w*undo\w*\s*[:=]\s*[\d_]{3,}\b/i)) {
        offenders.push(`${rel}:${lineOf(src, at)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('ui rules: one New button', () => {
  // Every Button whose label starts with "New " carries IconPlus before it.
  it('every <Button> labelled "New ..." includes IconPlus', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const { rel, src } of FILES) {
      for (const start of indexesOf(src, /<Button\b/)) {
        const el = element(src, start, 'Button');
        const open = openingTag(src, start);
        if (open.endsWith('/>')) continue;
        // Visible text: drop nested tags and {expressions}, keep literal text.
        const inner = el.slice(open.length).replace(/<\/Button>$/, '');
        const text = inner
          .replace(/\{[^{}]*\}/g, ' ')
          .replace(/<[^>]*>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text.startsWith('New ')) continue;
        seen += 1;
        if (!/<IconPlus\b/.test(inner)) offenders.push(`${rel}:${lineOf(src, start)}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
