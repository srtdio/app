// Pure, dependency-free word-level diff behind the PCS version-compare view.
// Captions are tokenized into alternating word / whitespace runs, aligned with a
// longest-common-subsequence pass, and the alignment is collapsed into contiguous
// eq / add / del segments the view paints. Nothing here reads the DOM or calls
// Supabase; it runs in the UI only.

/** A run of aligned text: unchanged (eq), only in the later caption (add), or
 *  only in the earlier caption (del). */
export type DiffKind = 'eq' | 'add' | 'del';

export interface DiffSegment {
  kind: DiffKind;
  text: string;
}

export interface DiffResult {
  /** Contiguous segments in reading order, or null on the guard path (the input
   *  was too large to align; the caller falls back to plain side-by-side). */
  segs: DiffSegment[] | null;
  /** Word tokens present only in the later caption. */
  addedWords: number;
  /** Word tokens present only in the earlier caption. */
  removedWords: number;
  /** round((addedWords + removedWords) / (wordsA + wordsB) * 100), 0 when both
   *  captions are wordless. */
  changedPct: number;
}

// One aligned token before same-kind runs are merged into segments.
interface Op {
  kind: DiffKind;
  text: string;
}

/** Split text into alternating word / whitespace tokens, keeping the whitespace
 *  runs so the segments reconstruct the caption exactly. Empty tokens (produced
 *  at string boundaries by the split) are dropped. */
export function tokenize(text: string): string[] {
  return text.split(/(\s+)/).filter((token) => token.length > 0);
}

// A word token is any non-whitespace run; whitespace tokens never count toward
// the added/removed word tallies.
function isWord(token: string): boolean {
  return token.trim().length > 0;
}

function countWords(tokens: readonly string[]): number {
  let n = 0;
  for (const token of tokens) if (isWord(token)) n += 1;
  return n;
}

function percentChanged(added: number, removed: number, wordsA: number, wordsB: number): number {
  const denom = wordsA + wordsB;
  if (denom === 0) return 0;
  return Math.round(((added + removed) / denom) * 100);
}

// LCS alignment of two token lists, backtracked into a flat op stream. dp is a
// flat (m+1)x(n+1) suffix table read through at() so noUncheckedIndexedAccess
// stays satisfied without non-null assertions.
function alignTokens(a: readonly string[], b: readonly string[]): Op[] {
  const m = a.length;
  const n = b.length;
  const width = n + 1;
  const dp = new Array<number>((m + 1) * width).fill(0);
  const at = (i: number, j: number): number => dp[i * width + j] ?? 0;

  for (let i = m - 1; i >= 0; i -= 1) {
    const ai = a[i];
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * width + j] = ai === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    const ai = a[i];
    const bj = b[j];
    if (ai === bj) {
      ops.push({ kind: 'eq', text: ai ?? '' });
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: 'del', text: ai ?? '' });
      i += 1;
    } else {
      ops.push({ kind: 'add', text: bj ?? '' });
      j += 1;
    }
  }
  while (i < m) {
    ops.push({ kind: 'del', text: a[i] ?? '' });
    i += 1;
  }
  while (j < n) {
    ops.push({ kind: 'add', text: b[j] ?? '' });
    j += 1;
  }
  return ops;
}

function mergeOps(ops: readonly Op[]): DiffSegment[] {
  const segs: DiffSegment[] = [];
  for (const op of ops) {
    const last = segs[segs.length - 1];
    if (last !== undefined && last.kind === op.kind) {
      last.text += op.text;
    } else {
      segs.push({ kind: op.kind, text: op.text });
    }
  }
  return segs;
}

/**
 * Word-level diff of two captions. Returns the merged eq/add/del segments plus
 * the added/removed word tallies and the percent of words touched.
 *
 * Guard: the LCS table is O(m*n) in both time and memory. Crash-early rather
 * than let a pair of multi-thousand-token captions freeze the tab: above two
 * million cells we return segs=null with counts taken from the whole-text word
 * counts (every word in A removed, every word in B added), and the caller draws
 * a plain side-by-side with no per-word marks.
 */
export function diffSegments(a: string, b: string): DiffResult {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const wordsA = countWords(tokensA);
  const wordsB = countWords(tokensB);

  if (tokensA.length * tokensB.length > 2_000_000) {
    return {
      segs: null,
      addedWords: wordsB,
      removedWords: wordsA,
      changedPct: percentChanged(wordsB, wordsA, wordsA, wordsB),
    };
  }

  const ops = alignTokens(tokensA, tokensB);
  let addedWords = 0;
  let removedWords = 0;
  for (const op of ops) {
    if (!isWord(op.text)) continue;
    if (op.kind === 'add') addedWords += 1;
    else if (op.kind === 'del') removedWords += 1;
  }

  return {
    segs: mergeOps(ops),
    addedWords,
    removedWords,
    changedPct: percentChanged(addedWords, removedWords, wordsA, wordsB),
  };
}
