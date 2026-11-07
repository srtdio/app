// Lighting guard: counts every lit-* class (one role per class name: lit-card,
// lit-media, lit-header, lit-focus-inset, ...) across src/**/*.{ts,tsx}
// (tests and src/components/home/** excluded, comments ignored) on origin/main
// and in the working tree, and fails when any role's count drops. A use of a
// part that always paints a role (PART_CARRIERS: <ListCard>, <Card>,
// <HeaderBar>, <Tag>, ...) counts as one occurrence of it on both sides, so a
// call site that moves onto the part keeps its count. The only other allowed
// drops: files retired on purpose (DELETED_ON_PURPOSE) and per-file drops
// checked by hand (EXPLAINED_DROPS). It also fails when src/index.css (where
// the lit-* recipes live) differs from main by a single byte, once the lines
// declaring a variable retired on purpose (RETIRED_CSS_VARS) leave main's copy.
//
//   node --experimental-strip-types --no-warnings scripts/lighting-guard.ts            check
//   node --experimental-strip-types --no-warnings scripts/lighting-guard.ts --verbose  + file:line lists
//
// The pure functions are exported for scripts/lighting-guard.test.ts.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE_REF = 'origin/main';
export const INDEX_CSS = 'src/index.css';

/**
 * CSS variables retired from src/index.css on purpose, with the reason. The
 * lines that declare only one of these are dropped from the main copy before
 * the byte comparison; every other change to index.css (additions included)
 * still fails.
 */
export const RETIRED_CSS_VARS: Record<string, string> = {
  '--annotation-bg': 'gold annotation retired, ink now',
  '--annotation-bg-rgb': 'gold annotation retired, ink now',
  '--annotation-line': 'gold annotation retired, ink now',
  '--annotation-line-rgb': 'gold annotation retired, ink now',
};

/**
 * The CSS with every line that only declares a retired variable
 * (`  --name: value;`) removed, newline included. Any other line, even one
 * that mentions the variable, is kept. Pure.
 */
export function stripRetiredCssVars(
  css: string,
  retired: readonly string[] = Object.keys(RETIRED_CSS_VARS),
): string {
  if (retired.length === 0) return css;
  const names = retired.map(escapeRe).join('|');
  const line = new RegExp(`^[ \\t]*(?:${names})[ \\t]*:[^;\\n]*;[ \\t]*\\r?\\n`, 'gm');
  return css.replace(line, '');
}

/**
 * Files retired on purpose (deleted, or emptied to a stub). Whatever lit-*
 * they lose may leave the count; every other drop is a lighting regression.
 */
export const DELETED_ON_PURPOSE: Record<string, string> = {
  'src/components/pages/pipeline/PipelineBoard.tsx':
    'Pipeline board view removed; Pipeline is a list of ListCard rows (lit-card on ListCard).',
  'src/components/pages/pipeline/board-columns.tsx': 'Board columns removed with the board view.',
  'src/components/pages/plan-tab/PlanCalendar.tsx':
    'Plan calendar view removed (file kept as a one-helper stub); Plan is a list of ListCard rows.',
  'src/components/pages/plan-tab/PlanDayMenu.tsx': 'Calendar day menu removed with the calendar.',
  'src/components/pages/plan-tab/PlanTabAdd.tsx':
    'Plan add picker removed; add goes through the shared Sheet.',
  'src/components/pages/assets/AssetCard.tsx':
    'Asset tile replaced by AssetListCard on ListCard (lit-card, lit-media, lit-selected live on ListCard).',
  'src/components/pages/assets/AssetGrid.tsx':
    'Asset grid replaced by the ListCard list (AssetListCard).',
  'src/components/pages/activity/AvatarStack.tsx':
    'Activity avatar stack replaced by the ListCard picture (Avatar lit-avatar).',
  'src/components/chat/StarredList.tsx': 'Message stars retired (chat simplification).',
  'src/components/chat/MarkBits.tsx':
    'Mark as retired; the select checkbox moved to SelectionBar (PressableRow).',
  'src/components/chat/MarksSheet.tsx': 'Mark as retired (the marks pin board and sheets).',
  'src/components/chat/ReminderSheet.tsx': 'Reminders retired (chat simplification).',
  'src/components/chat/ScheduleSheet.tsx': 'Scheduled send retired (chat simplification).',
  'src/components/chat/ScheduledListSheet.tsx': 'Scheduled send retired (chat simplification).',
  'src/components/chat/ScheduledStrip.tsx': 'Scheduled send retired (chat simplification).',
  'src/components/chat/WhenOptions.tsx':
    'The shared when picker retired with reminders and scheduled send.',
  'src/components/pages/pcs/CompareVersionsView.tsx': 'Compare versions retired.',
};

/**
 * Lit-* classes that left a file on purpose, each checked by hand: the element
 * is now drawn by a part whose lighting PART_CARRIERS cannot credit (a variant
 * prop such as Card muted / selected, a ListCard slot), or the element itself
 * is gone with a retired view. Keyed by file, then role: how many may leave
 * and why. Never more than the file's real drop.
 */
export const EXPLAINED_DROPS: Record<string, Record<string, { count: number; why: string }>> = {
  'src/components/chat/Composer.tsx': {
    'lit-btn-primary': {
      count: 1,
      why: 'The split Send / Schedule wrapper retired with scheduled send; Send is one round Button.',
    },
    'lit-well': { count: 1, why: 'The schedule upload bar on picked chips retired.' },
    'lit-fill': { count: 1, why: 'The schedule upload bar on picked chips retired.' },
  },
  'src/components/chat/MessageThread.tsx': {
    'lit-header': {
      count: 1,
      why: 'The inert "marks never read" ticker slot retired with Mark as.',
    },
  },
  'src/components/chat/StatusDrawer.tsx': {
    'lit-card-muted': { count: 1, why: "The mark row's stamp confirm retired with Mark as." },
  },
  'src/components/comments/Comments.tsx': {
    'lit-card-muted': {
      count: 4,
      why: 'No card per thread: the thread, batch group, skeleton and two empty cards are one OWN_CARD_CLASS (lit-card-muted) around the section.',
    },
  },
  'src/components/chat/tasks/TaskSheet.tsx': {
    'lit-well': { count: 1, why: 'The Tasks sheet search field (Input) retired.' },
    'lit-focus': { count: 1, why: 'The Tasks sheet search field (Input) retired.' },
    'lit-overlay': {
      count: 1,
      why: 'Full screen retired: the sheet is the one SHEET_FRAME height (lit-overlay kept there).',
    },
  },
  'src/components/chat/PlanScreen.tsx': {
    'lit-header': {
      count: 1,
      why: 'Two hand-built headers (two-line and one-line) are now one HeaderBar (lit-header).',
    },
    'lit-selected': {
      count: 1,
      why: "Today's day card is <Card selected>; Card paints lit-selected.",
    },
  },
  'src/components/pages/BriefCard.tsx': {
    'lit-card-muted': {
      count: 1,
      why: 'Closed brief is <ListCard muted>; ListCard paints lit-card-muted.',
    },
    'lit-hover': { count: 1, why: 'Whole-card tap is the ListCard cover (lit-hover).' },
    'lit-focus': {
      count: 1,
      why: 'Whole-card tap is the ListCard cover (focus-visible:lit-focus-inset).',
    },
    'lit-pill': {
      count: 1,
      why: 'BriefStatusPill had lit-pill twice (its own class and tagClass); tagClass keeps it.',
    },
  },
  'src/components/pages/BriefDetailPage.tsx': {
    'lit-header': {
      count: 1,
      why: 'Two hand-built top bars are one topBar() helper on HeaderBar (lit-header).',
    },
  },
  'src/components/pages/BriefsPage.tsx': {
    'lit-media': { count: 1, why: 'Skeleton card is ListCardBox; its picture box is lit-media.' },
    'lit-badge': {
      count: 1,
      why: 'Skeleton status bone retired with the old card; ListCardBox draws the card.',
    },
  },
  'src/components/pages/NotificationsPage.tsx': {
    'lit-overlay': {
      count: 1,
      why: "Upcoming's cancel confirm <Sheet> retired with the Upcoming chip (no scheduled send).",
    },
  },
  'src/components/pages/PipelinePage.tsx': {
    'lit-header': { count: 1, why: 'Board column skeleton header retired with the board view.' },
    'lit-well-soft': { count: 1, why: 'Board column skeleton retired with the board view.' },
  },
  'src/components/pages/PlanTabPage.tsx': {
    'lit-pill': {
      count: 2,
      why: 'Laptop bank-panel Add button and the Month/Week switch retired with the calendar.',
    },
    'lit-well': { count: 2, why: 'Laptop bank-panel search and the Month/Week switch retired.' },
    'lit-focus': { count: 2, why: 'Laptop bank-panel search and the Month/Week switch retired.' },
    'lit-hover': { count: 1, why: 'Month/Week switch option retired with the calendar.' },
  },
  'src/components/pages/PostCard.tsx': {
    'lit-hover': { count: 1, why: 'Whole-card tap is the ListCard cover (lit-hover).' },
    'lit-focus': {
      count: 1,
      why: 'Whole-card tap is the ListCard cover (focus-visible:lit-focus-inset).',
    },
  },
  'src/components/pages/PostDetailPage.tsx': {
    'lit-header': {
      count: 3,
      why: 'Four hand-built top bars are one topBar() helper on HeaderBar (lit-header).',
    },
  },
  'src/components/pages/pcs/PostLightbox.tsx': {
    'lit-focus': {
      count: 2,
      why: 'The "Remove this image?" confirm (its two buttons) retired; remove is the 4 s UndoStrip.',
    },
  },
  'src/components/pages/pcs/VersionHistorySheet.tsx': {
    'lit-selected': {
      count: 1,
      why: 'The picked row of the compare select retired with Compare versions.',
    },
    'lit-badge': {
      count: 1,
      why: 'The compare select tick circle retired with Compare versions.',
    },
  },
  'src/components/pages/activity/ActivityBoxes.tsx': {
    'lit-media': { count: 1, why: 'Skeleton card is ListCardBox; its picture box is lit-media.' },
    'lit-card': {
      count: 1,
      why: "UpcomingBoxes' <ListCardBox> retired with the Upcoming chip (scheduled send removed).",
    },
  },
  'src/components/pages/activity/ActivityCard.tsx': {
    'lit-hover': { count: 3, why: 'Card taps are the ListCard cover (lit-hover).' },
    'lit-focus-inset': {
      count: 3,
      why: 'Card taps are the ListCard cover (focus-visible:lit-focus-inset).',
    },
    'lit-media': { count: 2, why: 'Pictures sit in the ListCard picture box (lit-media).' },
    'lit-selected': { count: 1, why: 'Selected card is <ListCard selected> (lit-selected).' },
    'lit-pill': {
      count: 4,
      why: "Scope / Only you tags are ListCard's one tag (Tag, lit-pill); the +N files badge left with the old media grid.",
    },
    'lit-card': {
      count: 1,
      why: "UpcomingCard's <ListCard> retired with the Upcoming chip (scheduled send removed).",
    },
  },
  'src/components/pages/assets/AssetUploadSheet.tsx': {
    'lit-card-muted': { count: 1, why: 'Upload row is <Card muted>; Card paints lit-card-muted.' },
  },
  'src/components/pages/plan-tab/BankList.tsx': {
    'lit-header': {
      count: 1,
      why: 'Laptop bank table (its thead) retired; the Bank is one ListCard grid at both widths.',
    },
    'lit-hover': { count: 2, why: 'Row and table-row taps are the ListCard cover (lit-hover).' },
    'lit-focus': {
      count: 2,
      why: 'Row and table-row taps are the ListCard cover (focus-visible:lit-focus-inset).',
    },
    'lit-pill': {
      count: 5,
      why: "Bucket / who-can-see Tags are ListCard's one tag (Tag, lit-pill); the table's Tags retired with it.",
    },
    'lit-selected': {
      count: 2,
      why: 'Picked card is <ListCard selected> (lit-selected); the table row retired.',
    },
  },
  'src/components/pages/plan-tab/PlanTabList.tsx': {
    'lit-hover': { count: 1, why: 'Card tap is the ListCard cover (lit-hover).' },
    'lit-focus': {
      count: 1,
      why: 'Card tap is the ListCard cover (focus-visible:lit-focus-inset).',
    },
    'lit-media': { count: 4, why: 'Pictures sit in the ListCard picture box (lit-media).' },
    'lit-pill': { count: 1, why: "Draft tag is ListCard's one tag (Tag, lit-pill)." },
  },
  'src/components/preview/PlatformPreviewPanel.tsx': {
    'lit-spotlight': {
      count: 1,
      why: 'The separate Crop section retired (its "Shown" window); one cut row with Show cut.',
    },
    'lit-badge': {
      count: 1,
      why: 'The separate Crop section retired (its "Shown" label); one cut row with Show cut.',
    },
    'lit-well-soft': {
      count: 1,
      why: 'The size picker retired (unpicked SizeOption); placement comes from the post format.',
    },
    'lit-hover': {
      count: 2,
      why: 'The size picker retired (SizeOption lit-hover and its PressableRow).',
    },
    'lit-focus': { count: 1, why: "The size picker retired (SizeOption's PressableRow)." },
  },
  'src/components/pages/settings/MembersList.tsx': {
    'lit-pill': {
      count: 2,
      why: "Catch-up email Tags became a grey mail glyph (the role is the row's one tag).",
    },
  },
};

/**
 * Parts whose every use paints a lit role. A use at a call site counts as one
 * occurrence of that role on main and on the branch alike, so a call site that
 * moves from a hand-built lit-card frame onto the part keeps its count.
 * Matched as JSX (`<Card ` / `<Card>` / `<Card/>`) or a call (`cardSurface(`).
 */
export const PART_CARRIERS: { use: string; roles: string[]; part: string }[] = [
  { use: '<ListCard', roles: ['lit-card'], part: 'src/components/ui/ListCard.tsx' },
  { use: '<ListCardBox', roles: ['lit-card'], part: 'src/components/ui/ListCard.tsx' },
  { use: '<Card', roles: ['lit-card'], part: 'src/components/ui/Card.tsx' },
  { use: 'cardSurface(', roles: ['lit-card'], part: 'src/components/ui/Card.tsx' },
  { use: 'tagClass(', roles: ['lit-pill'], part: 'src/components/ui/Tag.tsx' },
  { use: 'popoverClass(', roles: ['lit-overlay'], part: 'src/components/ui/popover-classes.ts' },
  { use: 'SHEET_FRAME', roles: ['lit-overlay'], part: 'src/components/ui/Sheet.tsx' },
  { use: '<HeaderBar', roles: ['lit-header'], part: 'src/components/ui/HeaderBar.tsx' },
  { use: '<Tag', roles: ['lit-pill'], part: 'src/components/ui/Tag.tsx' },
  { use: '<Avatar', roles: ['lit-avatar'], part: 'src/components/ui/Avatar.tsx' },
  { use: '<Input', roles: ['lit-well', 'lit-focus'], part: 'src/components/ui/Input.tsx' },
  { use: '<Textarea', roles: ['lit-well', 'lit-focus'], part: 'src/components/ui/Textarea.tsx' },
  { use: '<Sheet', roles: ['lit-overlay'], part: 'src/components/ui/Sheet.tsx' },
  {
    use: '<PressableRow',
    roles: ['lit-hover', 'lit-focus'],
    part: 'src/components/ui/PressableRow.tsx',
  },
];

export interface Occurrence {
  role: string;
  file: string;
  line: number;
  /** The class token, variants included (focus-visible:lit-focus-inset), or the part use (<Card>). */
  token: string;
  /** 'class' for a literal lit-* class, 'part' for a PART_CARRIERS use. */
  kind: 'class' | 'part';
}

export type Counts = Record<string, number>;
export type FileMap = Record<string, string>;

/** Same file set as the design ratchet, minus the marketing home. */
export function isCounted(rel: string): boolean {
  const p = rel.split(sep).join('/');
  if (!p.startsWith('src/')) return false;
  if (!/\.(ts|tsx)$/.test(p) || p.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(p) || p.includes('/__tests__/')) return false;
  if (p.startsWith('src/components/home/')) return false;
  return true;
}

// A lit-* class: not glued to a word or dash on the left (so data-lit-x and
// unlit-x never count), variants such as hover: or focus-visible: allowed.
const LIT = /(?<![\w-])((?:[\w-]+:)*)(lit-[a-z0-9]+(?:-[a-z0-9]+)*)/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const CARRIER_RES = PART_CARRIERS.map((c) => ({
  ...c,
  re: c.use.startsWith('<')
    ? new RegExp(`${escapeRe(c.use)}(?=[\\s>/]|$)`, 'g')
    : new RegExp(`(?<![\\w.])${escapeRe(c.use)}${c.use.endsWith('(') ? '' : '(?!\\w)'}`, 'g'),
}));

/**
 * Blank out // and /* *\/ comments (prose that names a class lights nothing),
 * keeping every newline so line numbers hold. Strings and template literals
 * are kept as they are; a regex literal holding // is rare enough to ignore.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  // Open quotes; '}' is a ${ } inside a template literal, '{' a brace inside it.
  const stack: string[] = [];
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"' || top === '`') {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 2;
        continue;
      }
      if (c === top) stack.pop();
      else if (top === '`' && c === '$' && next === '{') {
        out += '{';
        stack.push('}');
        i += 2;
        continue;
      } else if (top !== '`' && c === '\n') stack.pop();
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') stack.push(c);
    else if ((top === '}' || top === '{') && c === '{') stack.push('{');
    else if ((top === '}' || top === '{') && c === '}') stack.pop();
    out += c;
    i++;
  }
  return out;
}

/** Blank out import / re-export statements (a part named in an import paints nothing). */
export function blankImports(src: string): string {
  return src.replace(/^(?:import|export)\b[^;]*?\bfrom\s*['"][^'"]*['"];?/gm, (m) =>
    m.replace(/[^\n]/g, ' '),
  );
}

export function scanSource(file: string, src: string): Occurrence[] {
  const out: Occurrence[] = [];
  const code = stripComments(src);
  const lines = code.split('\n');
  const useLines = blankImports(code).split('\n');
  const carriers = CARRIER_RES.filter((c) => c.part !== file);
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!;
    for (const m of text.matchAll(LIT)) {
      out.push({ role: m[2]!, file, line: i + 1, token: `${m[1] ?? ''}${m[2]!}`, kind: 'class' });
    }
    for (const c of carriers) {
      const uses = useLines[i]!.match(c.re)?.length ?? 0;
      const token = c.use.startsWith('<') ? `${c.use}>` : c.use.endsWith('(') ? `${c.use})` : c.use;
      for (let n = 0; n < uses; n++) {
        for (const role of c.roles) out.push({ role, file, line: i + 1, token, kind: 'part' });
      }
    }
  }
  return out;
}

export function scanFiles(files: FileMap): Occurrence[] {
  const out: Occurrence[] = [];
  for (const file of Object.keys(files).sort()) {
    if (!isCounted(file)) continue;
    out.push(...scanSource(file, files[file]!));
  }
  return out;
}

export function countRoles(occ: Occurrence[]): Counts {
  const counts: Counts = {};
  for (const o of occ) counts[o.role] = (counts[o.role] ?? 0) + 1;
  return counts;
}

function countBy(occ: Occurrence[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const o of occ) {
    const k = `${o.file}\u0000${o.role}`;
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return map;
}

export interface RoleRow {
  role: string;
  main: number;
  branch: number;
  /** How much of the drop the allowlists explain (retired files, moves onto parts). */
  allowed: number;
  ok: boolean;
}

export interface Allowance {
  file: string;
  role: string;
  count: number;
  why: string;
}

export interface Comparison {
  rows: RoleRow[];
  drops: RoleRow[];
  /** Every allowed per-file drop that applied, with its reason. */
  allowances: Allowance[];
}

export function compareLighting(
  main: FileMap,
  branch: FileMap,
  retired: Record<string, string> = DELETED_ON_PURPOSE,
  explained: Record<string, Record<string, { count: number; why: string }>> = EXPLAINED_DROPS,
): Comparison {
  const mainOcc = scanFiles(main);
  const branchOcc = scanFiles(branch);
  const mainCounts = countRoles(mainOcc);
  const branchCounts = countRoles(branchOcc);
  const mainBy = countBy(mainOcc);
  const branchBy = countBy(branchOcc);
  const allowances: Allowance[] = [];
  for (const [k, before] of mainBy) {
    const [file, role] = k.split('\u0000') as [string, string];
    const drop = before - (branchBy.get(k) ?? 0);
    if (drop <= 0) continue;
    const why = retired[file];
    if (why !== undefined) {
      allowances.push({ file, role, count: drop, why });
      continue;
    }
    const m = explained[file]?.[role];
    if (m !== undefined)
      allowances.push({ file, role, count: Math.min(drop, m.count), why: m.why });
  }
  const allowedCounts: Counts = {};
  for (const a of allowances) allowedCounts[a.role] = (allowedCounts[a.role] ?? 0) + a.count;
  const roles = [...new Set([...Object.keys(mainCounts), ...Object.keys(branchCounts)])].sort();
  const rows = roles.map((role) => {
    const m = mainCounts[role] ?? 0;
    const b = branchCounts[role] ?? 0;
    const a = allowedCounts[role] ?? 0;
    return { role, main: m, branch: b, allowed: a, ok: b >= m - a };
  });
  return { rows, drops: rows.filter((r) => !r.ok), allowances };
}

export interface Change {
  sign: '+' | '-';
  occ: Occurrence;
}

/** Longest common subsequence of two token lists; returns the unmatched indexes of each. */
function unmatched(a: string[], b: string[]): { a: number[]; b: number[] } {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ua: number[] = [];
  const ub: number[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) ua.push(i++);
    else ub.push(j++);
  }
  while (i < n) ua.push(i++);
  while (j < m) ub.push(j++);
  return { a: ua, b: ub };
}

/**
 * Every lit-* occurrence (and part use) added or removed, file by file: the
 * file's ordered tokens on main and on the branch, matched by their longest
 * common run, so an untouched class never shows even when lines moved.
 */
export function diffOccurrences(main: FileMap, branch: FileMap): Change[] {
  const byFile = (occ: Occurrence[]) => {
    const map = new Map<string, Occurrence[]>();
    for (const o of occ) {
      const list = map.get(o.file) ?? [];
      list.push(o);
      map.set(o.file, list);
    }
    return map;
  };
  const m = byFile(scanFiles(main));
  const b = byFile(scanFiles(branch));
  const out: Change[] = [];
  for (const file of [...new Set([...m.keys(), ...b.keys()])].sort()) {
    const before = m.get(file) ?? [];
    const after = b.get(file) ?? [];
    const key = (o: Occurrence) => `${o.role} ${o.token}`;
    const u = unmatched(before.map(key), after.map(key));
    for (const i of u.a) out.push({ sign: '-', occ: before[i]! });
    for (const j of u.b) out.push({ sign: '+', occ: after[j]! });
  }
  return out;
}

export function formatTable(rows: RoleRow[]): string[] {
  const w = Math.max(4, ...rows.map((r) => r.role.length));
  return rows.map((r) => {
    const note = r.allowed > 0 ? `  (${r.allowed} allowed)` : '';
    const flag = r.ok ? '' : '  DROP';
    return `${r.role.padEnd(w)}  ${String(r.main).padStart(4)} -> ${String(r.branch).padStart(4)}${note}${flag}`;
  });
}

// ---------------------------------------------------------------- repo I/O

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

export function readMain(root: string, ref = BASE_REF): FileMap {
  const files: FileMap = {};
  const names = git(root, ['ls-tree', '-r', '--name-only', ref, 'src'])
    .split('\n')
    .filter((p) => p && isCounted(p));
  for (const p of names) files[p] = git(root, ['show', `${ref}:${p}`]);
  return files;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

export function readBranch(root: string): FileMap {
  const files: FileMap = {};
  const all: string[] = [];
  const srcDir = join(root, 'src');
  if (existsSync(srcDir)) walk(srcDir, all);
  for (const full of all) {
    const rel = relative(root, full).split(sep).join('/');
    if (isCounted(rel)) files[rel] = readFileSync(full, 'utf8');
  }
  return files;
}

export interface RunOptions {
  root: string;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

export function run(argv: string[], opts: RunOptions): number {
  const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
  const error = opts.error ?? ((l: string) => process.stderr.write(`${l}\n`));
  const verbose = argv.includes('--verbose');

  const main = readMain(opts.root);
  const branch = readBranch(opts.root);
  const cmp = compareLighting(main, branch);

  log(`Lighting roles, ${BASE_REF} -> working tree:`);
  for (const l of formatTable(cmp.rows)) log(`  ${l}`);
  if (cmp.allowances.length > 0) {
    log('\nAllowed drops (retired files, moves onto a part):');
    for (const a of cmp.allowances) log(`  ${a.file}  ${a.role} -${a.count}: ${a.why}`);
  }

  if (verbose) {
    const changes = diffOccurrences(main, branch);
    log(changes.length > 0 ? '\nlit-* added (+) and removed (-):' : '\nNo lit-* changes.');
    for (const c of changes) log(`  ${c.sign} ${c.occ.file}:${c.occ.line}  ${c.occ.token}`);
  }

  let code = 0;
  // Retired variables (RETIRED_CSS_VARS) leave the main copy first; nothing else may differ.
  const cssMain = stripRetiredCssVars(git(opts.root, ['show', `${BASE_REF}:${INDEX_CSS}`]));
  const cssPath = join(opts.root, INDEX_CSS);
  const cssBranch = existsSync(cssPath) ? readFileSync(cssPath, 'utf8') : '';
  if (cssMain !== cssBranch) {
    error(`\nLighting guard: ${INDEX_CSS} differs from ${BASE_REF}. Lighting recipes are locked.`);
    code = 1;
  }
  if (cmp.drops.length > 0) {
    for (const r of cmp.drops) {
      error(
        `\nLighting guard: ${r.role} dropped ${r.main} -> ${r.branch}` +
          (r.allowed > 0 ? ` (only ${r.allowed} of it is allowed)` : '') +
          '.',
      );
    }
    error('Put the class back on the element, or on the part that took its place.');
    code = 1;
  }
  if (code === 0) log('\nLighting guard: ok.');
  return code;
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  process.exitCode = run(process.argv.slice(2), { root });
}
