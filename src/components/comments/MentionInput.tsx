// A contentEditable comment composer with inline @-mention chips. Typing "@" at
// the start of the text or right after whitespace opens a dropdown of the
// workspace's members, filtered by the run typed after the @. Selecting a member
// drops a non-editable chip (rendered "@Name", accent token styling) carrying the
// member id in data-mention-id; on every input the SERIALIZED body is reported
// through onChange, with each chip becoming the existing @[uuid] token so
// comment_create / @srtdio/comments parse, validate, and notify unchanged.
//
// The editor holds its text as a string (paired markers hidden with formatting
// on, src/lib/format-live.ts) and draws it: styled spans, chips, text. A
// browser edit is read back, settled (pairs hide, broken ones go, text beside
// hidden markers lands on the side that keeps them) and the editor is redrawn
// only where it differs, caret restored by text offset. New lines, paste,
// drop and Undo are the editor's own (plain text, never a browser <div>). The
// @ list is chat's MentionPicker, hung above the writing box like chat's.
//
// Pure functions (serializeComposer, activeMentionQuery, buildInitialContent,
// insertTextAtPoint, readEditorText) carry the logic that can be unit-tested
// without a DOM; caret / selection behaviour is exercised in the browser.

import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent } from 'react';
import type { FormatStyle } from '@srtdio/comments';
import { fieldSelection, restoreSelection, useFormatKeys } from '@/components/ui/format-actions';
import { liveStyleClass } from '@/components/ui/Textarea';
import { MentionPicker, mentionComboboxProps, stepActive } from '@/components/chat/MentionPicker';
import type { MentionMember } from '@/lib/chat/mentions';
import type { MentionCandidate } from '@/lib/workspace-members';
import { useEscapeLayer } from '@/lib/escape-stack';
import { cn } from '@/lib/cn';
import {
  decodeMarkers,
  deleteBesideHidden,
  encodeMarkers,
  historyKind,
  historyPush,
  historyStart,
  historyStep,
  isHiddenMarker,
  liveEdit,
  liveSegments,
  normalizeLive,
  registerLiveField,
  stepOverHidden,
  stripHiddenMarkers,
  togglePendingStyle,
  type LiveHistory,
  type LiveText,
} from '@/lib/format-live';

// The editor's own field look (a standalone field), and the bare editor inside
// ui/Composer's field: the field draws the line, the well and the focus line;
// 16px on phone so iOS never zooms, 14px from md.
const FIELD_EDITOR =
  'w-full whitespace-pre-wrap break-words rounded-lg border border-field bg-panel px-3 py-field-y text-base text-fg outline-none lit-well focus:lit-focus min-h-11 empty:before:content-[attr(data-placeholder)] before:pointer-events-none before:text-fg-3';
const BARE_EDITOR =
  'w-full whitespace-pre-wrap break-words bg-transparent py-2 text-input text-fg outline-none md:text-base empty:before:content-[attr(data-placeholder)] before:pointer-events-none before:text-fg-3';

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** Non-breaking spaces are normalised to plain spaces so the stored body matches
 *  what the user sees and the server's length / parse rules behave predictably.
 *  Newlines are preserved: the composer is multi-line and `\n` is significant. */
function normalizeSpaces(text: string): string {
  return text.replace(/\u00a0/g, ' ');
}

/**
 * Serialize the composer to the body string the server stores by walking the FULL
 * subtree depth-first in document order. Text nodes contribute their value (nbsp
 * normalised, newlines preserved). A mention chip (non-empty data-mention-id)
 * contributes `@[<uuid>]` and is not descended into. A `` becomes `\n`; a block
 * element (`` / ``) inserts a `\n` boundary when one is not already present, then
 * its children are walked; any other inline element is descended into. This way a
 * chip the browser nests inside a block (e.g. on a second line) still emits its
 * token rather than its plain display name, and line breaks survive.
 */
export function serializeComposer(root: HTMLElement): string {
  let out = '';

  function walk(node: Node): void {
    if (node.nodeType === TEXT_NODE) {
      out += normalizeSpaces(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;

    const el = node as HTMLElement;
    const id = el.dataset?.mentionId;
    if (id !== undefined && id !== '') {
      out += `@[${id}]`;
      return;
    }
    const tag = el.tagName;
    if (tag === 'BR') {
      out += '\n';
      return;
    }
    if (tag === 'DIV' || tag === 'P') {
      if (out !== '' && !out.endsWith('\n')) out += '\n';
    }
    el.childNodes.forEach(walk);
  }

  root.childNodes.forEach(walk);
  // A live editor holds paired markers hidden: the body is the saved text.
  return decodeMarkers(out);
}

/**
 * The active mention query: the run typed after a trigger "@" when the caret sits
 * in an @run that begins at the start of the text or right after whitespace and
 * contains no whitespace itself. Returns the query (possibly empty, just after a
 * bare "@") or null when there is no open mention run before the caret.
 */
export function activeMentionQuery(textBeforeCaret: string): string | null {
  const at = textBeforeCaret.lastIndexOf('@');
  if (at === -1) return null;
  const prev = textBeforeCaret[at - 1];
  if (at > 0 && !/\s/.test(prev ?? '')) return null;
  const query = textBeforeCaret.slice(at + 1);
  if (/\s/.test(query)) return null;
  return query;
}

/** The stored mention token; the same shape parseMentions / renderCommentBody use. */
const INITIAL_MENTION_TOKEN =
  /@\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/** The slice of `document` needed to build seeded editor content; lets the builder
 *  be exercised with a fake factory in the node test env (no jsdom). */
interface NodeFactory {
  createElement(tagName: 'span'): HTMLElement;
  createTextNode(data: string): Text;
}

/**
 * Build the seeded editor children from a stored body, in document order. Each
 * @[uuid] token whose uuid resolves to a member becomes a mention chip IDENTICAL
 * to the one selectMember builds (so it serializes back to the same token); a
 * token with no matching member is kept as its literal text so nothing is ever
 * dropped. Text between tokens is appended verbatim.
 */
export function buildInitialContent(
  body: string,
  members: MentionCandidate[],
  factory: NodeFactory,
): Node[] {
  const nodes: Node[] = [];
  let last = 0;
  for (const match of body.matchAll(INITIAL_MENTION_TOKEN)) {
    const start = match.index ?? 0;
    if (start > last) nodes.push(factory.createTextNode(body.slice(last, start)));
    const id = (match[1] ?? '').toLowerCase();
    const candidate = members.find((m) => m.id === id);
    if (candidate !== undefined) {
      const chip = factory.createElement('span');
      chip.setAttribute('contenteditable', 'false');
      chip.dataset.mentionId = candidate.id;
      chip.className = 'rounded px-1 font-medium text-accent bg-accent-soft';
      chip.textContent = `@${candidate.username ?? candidate.name}`;
      nodes.push(chip);
    } else {
      nodes.push(factory.createTextNode(match[0]));
    }
    last = start + match[0].length;
  }
  if (last < body.length) nodes.push(factory.createTextNode(body.slice(last)));
  return nodes;
}

/** A caret position in DOM Range terms: a node and an offset within it. */
export interface CaretPoint {
  node: Node;
  offset: number;
}

/** The slice of `document` insertTextAtPoint needs (a fake in node tests). */
interface TextFactory {
  createTextNode(data: string): Text;
}

function isWithin(root: Node, node: Node | null): boolean {
  for (let at = node; at !== null; at = at.parentNode) {
    if (at === root) return true;
  }
  return false;
}

/** The mention chip holding `node`, if any: text never goes inside a chip. */
function enclosingChip(root: Node, node: Node): Node | null {
  for (let at: Node | null = node; at !== null && at !== root; at = at.parentNode) {
    if (at.nodeType !== ELEMENT_NODE) continue;
    const id = (at as HTMLElement).dataset?.mentionId;
    if (id !== undefined && id !== '') return at;
  }
  return null;
}

function childIndex(parent: Node, child: Node): number {
  return Array.from(parent.childNodes).indexOf(child as ChildNode);
}

/**
 * Insert plain text at `point` inside the editor and return the caret just
 * after it. A point inside a text node splices into that node; a point between
 * children inserts a new text node there. A point inside a mention chip moves
 * to just after the chip (the chip is never split). No point, or one outside
 * the editor, means the end (before a trailing placeholder <br>). Mention chips
 * are never touched, so serializeComposer still emits their @[uuid] tokens.
 */
export function insertTextAtPoint(
  root: HTMLElement,
  point: CaretPoint | null,
  text: string,
  factory: TextFactory,
): CaretPoint {
  let target: CaretPoint;
  if (point === null || !isWithin(root, point.node)) {
    const last = root.childNodes[root.childNodes.length - 1];
    const trailingBr =
      last !== undefined &&
      last.nodeType === ELEMENT_NODE &&
      (last as HTMLElement).tagName === 'BR';
    target = { node: root, offset: root.childNodes.length - (trailingBr ? 1 : 0) };
  } else {
    const chip = enclosingChip(root, point.node);
    const parent = chip?.parentNode ?? null;
    target =
      chip !== null && parent !== null
        ? { node: parent, offset: childIndex(parent, chip) + 1 }
        : point;
  }
  if (target.node.nodeType === TEXT_NODE) {
    const value = target.node.nodeValue ?? '';
    const at = Math.max(0, Math.min(target.offset, value.length));
    target.node.nodeValue = value.slice(0, at) + text + value.slice(at);
    return { node: target.node, offset: at + text.length };
  }
  const node = factory.createTextNode(text);
  target.node.insertBefore(node, target.node.childNodes[target.offset] ?? null);
  return { node, offset: text.length };
}


/** The chip a mention token renders as (the same one buildInitialContent builds). */
function mentionChip(candidate: MentionCandidate): HTMLElement {
  const chip = document.createElement('span');
  chip.setAttribute('contenteditable', 'false');
  chip.dataset.mentionId = candidate.id;
  chip.className = 'rounded px-1 font-medium text-accent bg-accent-soft';
  chip.textContent = `@${candidate.username ?? candidate.name}`;
  return chip;
}

/**
 * The editor's text as it holds it (live formatting: paired markers hidden,
 * src/lib/format-live.ts): text nodes as they are (nbsp as a space), a chip
 * as its @[uuid] token, a <br> as a newline, block boundaries as newlines.
 * The last <br> only holds an empty last line open, so it reads as nothing.
 */
export function readEditorText(root: HTMLElement): string {
  let out = '';
  let lastBr: Node | null = null;
  for (let at: Node | null = root.lastChild; at !== null; at = at.lastChild) {
    if (at.nodeType === ELEMENT_NODE && (at as HTMLElement).tagName === 'BR') {
      lastBr = at;
      break;
    }
    if (at.nodeType !== ELEMENT_NODE) break;
  }
  function walk(node: Node): void {
    if (node.nodeType === TEXT_NODE) {
      out += normalizeSpaces(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const id = el.dataset?.mentionId;
    if (id !== undefined && id !== '') {
      out += `@[${id}]`;
      return;
    }
    if (el.tagName === 'BR') {
      if (node !== lastBr) out += '\n';
      return;
    }
    if ((el.tagName === 'DIV' || el.tagName === 'P') && out !== '' && !out.endsWith('\n')) {
      out += '\n';
    }
    el.childNodes.forEach(walk);
  }
  root.childNodes.forEach(walk);
  return out;
}

const TOKEN_SPLIT = /(@\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\])/i;
const TOKEN_SPLIT_ALL = /@\[[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\]/gi;

/** One planned child of the editor: a text run, a styled span, a chip or the trailing <br>. */
type PlanNode =
  | { kind: 'text'; text: string }
  | { kind: 'span'; cls: string; children: PlanNode[] }
  | { kind: 'chip'; candidate: MentionCandidate }
  | { kind: 'br' };

/** Text with its known mention tokens as chips (unknown ones stay literal text). */
function withChips(text: string, members: readonly MentionCandidate[]): PlanNode[] {
  if (!text.includes('@[')) return text === '' ? [] : [{ kind: 'text', text }];
  const out: PlanNode[] = [];
  for (const part of text.split(TOKEN_SPLIT)) {
    if (part === '') continue;
    const m = /^@\[([0-9a-f-]{36})\]$/i.exec(part);
    const candidate =
      m !== null ? members.find((c) => c.id === (m[1] ?? '').toLowerCase()) : undefined;
    out.push(candidate !== undefined ? { kind: 'chip', candidate } : { kind: 'text', text: part });
  }
  return out;
}

/** What the editor should hold for a text: styled spans, chips, the trailing <br>. Pure. */
function editorPlan(text: string, members: readonly MentionCandidate[]): PlanNode[] {
  const plan: PlanNode[] = [];
  for (const seg of liveSegments(text)) {
    const children = withChips(seg.text, members);
    if (seg.marker || seg.styles.length === 0) plan.push(...children);
    else plan.push({ kind: 'span', cls: liveStyleClass(seg.styles), children });
  }
  if (text.endsWith('\n')) plan.push({ kind: 'br' });
  return plan;
}

/** A plan or a DOM subtree as one comparable string (adjacent text merged). */
function planKey(nodes: readonly PlanNode[]): string {
  let out = '';
  let text = '';
  const flush = (): void => {
    if (text !== '') out += `t${text.length}:${text}`;
    text = '';
  };
  for (const n of nodes) {
    if (n.kind === 'text') {
      text += n.text;
      continue;
    }
    flush();
    if (n.kind === 'span') out += `s(${n.cls}|${planKey(n.children)})`;
    else if (n.kind === 'chip') out += `c${n.candidate.id}`;
    else out += 'b';
  }
  flush();
  return out;
}

/** The editor's DOM as plan nodes (anything unplanned reads as itself, so it mismatches). */
function domPlan(parent: Node): PlanNode[] {
  const out: PlanNode[] = [];
  parent.childNodes.forEach((node) => {
    if (node.nodeType === TEXT_NODE) {
      out.push({ kind: 'text', text: node.nodeValue ?? '' });
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const id = el.dataset?.mentionId;
    if (id !== undefined && id !== '') {
      out.push({
        kind: 'chip',
        candidate: { id, name: '', username: null, role: '', avatarUrl: null },
      });
      return;
    }
    if (el.tagName === 'BR' && el.dataset?.trail !== undefined) {
      out.push({ kind: 'br' });
      return;
    }
    if (el.tagName === 'SPAN' && el.dataset?.liveStyle !== undefined) {
      out.push({ kind: 'span', cls: el.className, children: domPlan(el) });
      return;
    }
    // A <div>, <b>, a bare <br>: never planned, so the editor is redrawn.
    out.push({ kind: 'span', cls: `?${el.tagName}`, children: domPlan(el) });
  });
  return out;
}

function buildPlan(target: Node, nodes: readonly PlanNode[]): void {
  for (const n of nodes) {
    if (n.kind === 'text') target.appendChild(document.createTextNode(n.text));
    else if (n.kind === 'chip') target.appendChild(mentionChip(n.candidate));
    else if (n.kind === 'br') {
      const br = document.createElement('br');
      br.dataset.trail = '';
      target.appendChild(br);
    } else {
      const span = document.createElement('span');
      span.dataset.liveStyle = '';
      span.className = n.cls;
      buildPlan(span, n.children);
      target.appendChild(span);
    }
  }
}

/** Redraw the editor for `text` when what it holds differs; true when it redrew. */
function drawEditor(
  root: HTMLElement,
  text: string,
  members: readonly MentionCandidate[],
): boolean {
  const plan = editorPlan(text, members);
  if (planKey(domPlan(root)) === planKey(plan)) return false;
  root.textContent = '';
  buildPlan(root, plan);
  return true;
}

/** What a parent can do to the editor (the laptop emoji button inserts here). */
export interface MentionInputHandle {
  /** Insert text at the last caret in the editor (else the end), caret after it. */
  insertText: (text: string) => void;
  /** The editable itself (ui/WritingBox's Aa row formats it in place). */
  element: () => HTMLElement | null;
}

interface MentionInputProps {
  members: MentionCandidate[];
  placeholder: string;
  autoFocus?: boolean;
  onChange: (body: string) => void;
  /** Seed the editor once on mount (e.g. a reply pre-tagging the author). When
   *  empty / undefined the editor mounts blank and uncontrolled, exactly as before. */
  initialBody?: string | undefined;
  /** Opt-in WYSIWYG formatting: styles show live with their markers hidden
   *  (src/lib/format-live.ts), lists and quotes (Return continues them) and
   *  the Cmd/Ctrl shortcuts; the buttons live in ui/WritingBox's Aa row. The
   *  body reported is the saved marker text. Off, the editor is exactly as
   *  before. */
  formatting?: boolean;
  /** Focus and blur, for ui/WritingBox's focused look. */
  onFocus?: () => void;
  /** Inside ui/Composer's field (ComposerFrame): the editor draws no line, well
   *  or focus line of its own (the field owns the one look) and fills the field. */
  bare?: boolean;
}

/** A person as chat's @ picker draws them (the same list in comments as in chat). */
function pickerMember(c: MentionCandidate): MentionMember {
  return {
    userId: c.id,
    displayName: c.name,
    avatarUrl: c.avatarUrl,
    username: c.username,
    role: c.role === '' ? null : c.role,
  };
}

export const MentionInput = forwardRef<MentionInputHandle, MentionInputProps>(function MentionInput(
  {
    members,
    placeholder,
    autoFocus = false,
    onChange,
    initialBody,
    formatting = false,
    bare = false,
    onFocus,
  },
  ref,
) {
  const editorRef = useRef<HTMLDivElement>(null);
  const formatKeys = useFormatKeys(editorRef, formatting);
  const seeded = useRef(false);
  const membersRef = useRef(members);
  membersRef.current = members;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // The text as the editor holds it after the last settled edit (hidden
  // markers included), the edit in flight, pending styles, the undo history.
  const held = useRef('');
  const composing = useRef(false);
  const pending = useRef<{ styles: FormatStyle[]; at: number }>({ styles: [], at: -1 });
  const history = useRef<LiveHistory>(historyStart({ text: '', start: 0, end: 0 }));
  const editKind = useRef('edit');
  // The last selection inside the editor (text offsets), kept while focus is
  // elsewhere (the emoji picker's search field) so an insert lands where the
  // caret was.
  const savedSel = useRef<{ start: number; end: number } | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const listId = useId();
  // The writing box's list slot (above the box, like chat's pickers), found
  // when the list first opens; null outside a writing box.
  const [listSlot, setListSlot] = useState<HTMLElement | null>(null);

  function selectionNow(root: HTMLElement): { start: number; end: number } | null {
    const sel = window.getSelection();
    if (sel === null || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const { start, end } = fieldSelection(root);
    return { start, end };
  }

  function emit(): void {
    onChangeRef.current(decodeMarkers(held.current));
  }

  /** Put a settled text in the editor (redrawn only where it differs), caret placed. */
  function applyText(next: LiveText, kind: string, focus = true): void {
    const root = editorRef.current;
    if (root === null) return;
    const redrew = drawEditor(root, next.text, membersRef.current);
    held.current = next.text;
    if (redrew || focus) {
      if (focus) root.focus({ preventScroll: true });
      restoreSelection(root, next.start, next.end);
    }
    savedSel.current = { start: next.start, end: next.end };
    history.current = historyPush(
      history.current,
      { text: next.text, start: next.start, end: next.end },
      kind,
      Date.now(),
    );
    emit();
    refreshQuery();
  }

  /** Splice saved text into the editor at [from, to) through the live rules. */
  function spliceText(
    from: number,
    to: number,
    insert: string,
    selStart: number,
    selEnd: number,
  ): void {
    const base = held.current;
    const next = formatting
      ? normalizeLive(base.slice(0, from) + insert + base.slice(to), selStart, selEnd)
      : { text: base.slice(0, from) + insert + base.slice(to), start: selStart, end: selEnd };
    applyText(next, 'edit');
  }

  // Seed the editor once per mount when an initialBody is given: chips and
  // text, the caret AFTER the content, focus, and emit so the parent body
  // state is primed. Guarded by a ref so it never re-runs.
  useEffect(() => {
    if (seeded.current) return;
    const root = editorRef.current;
    if (root === null || initialBody === undefined || initialBody === '') return;
    seeded.current = true;
    const text = formatting ? encodeMarkers(initialBody) : initialBody;
    drawEditor(root, text, membersRef.current);
    held.current = text;
    history.current = historyStart({ text, start: text.length, end: text.length });
    root.focus();
    restoreSelection(root, text.length, text.length);
    emit();
    // members/initialBody are mount-stable for a given composer instance; the ref
    // guard makes this run-once regardless.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // When seeded, the effect above already focused with the caret at the end;
    // do not re-focus here or the caret would jump back to the start.
    if (initialBody !== undefined && initialBody !== '') return;
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus, initialBody]);

  // Keep the caret (as offsets) while it is in the editor.
  useEffect(() => {
    const onSelection = (): void => {
      const root = editorRef.current;
      if (root === null) return;
      const at = selectionNow(root);
      if (at === null) return;
      savedSel.current = at;
      const p = pending.current;
      if (p.styles.length > 0 && at.start !== p.at) pending.current = { styles: [], at: -1 };
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Register with the format actions (the Aa row and the shortcuts).
  useEffect(() => {
    const root = editorRef.current;
    if (!formatting || root === null) return undefined;
    return registerLiveField(root, {
      replace: (from, to, insert, selStart, selEnd) =>
        spliceText(from, to, insert, selStart, selEnd),
      pending: () => pending.current.styles,
      togglePending: (style) => {
        root.focus({ preventScroll: true });
        const at = selectionNow(root)?.start ?? held.current.length;
        pending.current = { styles: togglePendingStyle(pending.current.styles, style), at };
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatting]);

  /** Settle what the browser just did (typing, autocorrect, a cut): read, normalise, redraw. */
  function settle(kind: string): void {
    const root = editorRef.current;
    if (root === null) return;
    const now = readEditorText(root);
    const sel = selectionNow(root) ?? { start: now.length, end: now.length };
    let next: LiveText = { text: now, start: sel.start, end: sel.end };
    if (formatting) {
      const r = liveEdit(held.current, now, sel, pending.current.styles);
      if (r.usedPending) pending.current = { styles: [], at: -1 };
      else if (pending.current.styles.length > 0) {
        pending.current = { styles: pending.current.styles, at: r.start };
      }
      next = r;
    }
    const redrew = drawEditor(root, next.text, membersRef.current);
    held.current = next.text;
    if (redrew || next.start !== sel.start || next.end !== sel.end) {
      restoreSelection(root, next.start, next.end);
    }
    savedSel.current = { start: next.start, end: next.end };
    history.current = historyPush(
      history.current,
      { text: next.text, start: next.start, end: next.end },
      kind,
      Date.now(),
    );
    emit();
    refreshQuery();
  }

  function stepHistory(dir: -1 | 1): void {
    const step = historyStep(history.current, dir);
    if (step === null) return;
    history.current = step.history;
    const root = editorRef.current;
    if (root === null) return;
    drawEditor(root, step.snap.text, membersRef.current);
    held.current = step.snap.text;
    restoreSelection(root, step.snap.start, step.snap.end);
    savedSel.current = { start: step.snap.start, end: step.snap.end };
    emit();
    refreshQuery();
  }

  // The edits the editor owns: new lines (never a browser <div>), paste and
  // drop as plain text, Undo / Redo, and Backspace / Delete beside a hidden
  // marker (the visible character goes, never the marker alone).
  useEffect(() => {
    const root = editorRef.current;
    if (root === null) return undefined;
    const onBeforeInput = (e: Event): void => {
      const ie = e as InputEvent;
      editKind.current = historyKind(ie.inputType);
      if (ie.isComposing || composing.current) return;
      const sel = selectionNow(root);
      if (sel === null) return;
      const type = ie.inputType;
      if (type === 'historyUndo' || type === 'historyRedo') {
        e.preventDefault();
        stepHistory(type === 'historyUndo' ? -1 : 1);
        return;
      }
      if (type === 'insertParagraph' || type === 'insertLineBreak') {
        e.preventDefault();
        spliceText(sel.start, sel.end, '\n', sel.start + 1, sel.start + 1);
        return;
      }
      if (type === 'insertFromDrop' || type === 'insertFromPaste') {
        const data = ie.dataTransfer?.getData('text/plain') ?? '';
        e.preventDefault();
        if (data !== '') {
          const at = sel.start + data.length;
          spliceTextSettled(sel.start, sel.end, data, at);
        }
        return;
      }
      if (
        formatting &&
        (type === 'deleteContentBackward' || type === 'deleteContentForward') &&
        sel.start === sel.end
      ) {
        const span = deleteBesideHidden(
          held.current,
          sel.start,
          type === 'deleteContentBackward' ? -1 : 1,
        );
        if (span === null) return;
        e.preventDefault();
        spliceText(span.from, span.to, '', span.from, span.from);
      }
    };
    // Paste fires before beforeinput in every engine: take it there (plain text only).
    const onPaste = (e: ClipboardEvent): void => {
      const sel = selectionNow(root);
      const data = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      if (sel === null || data === '') return;
      spliceTextSettled(sel.start, sel.end, data, sel.start + data.length);
    };
    const onCopy = (e: ClipboardEvent, cut: boolean): void => {
      const sel = selectionNow(root);
      if (sel === null || sel.start === sel.end || e.clipboardData === null) return;
      e.preventDefault();
      e.clipboardData.setData('text/plain', decodeMarkers(held.current.slice(sel.start, sel.end)));
      if (cut) spliceText(sel.start, sel.end, '', sel.start, sel.start);
    };
    const copy = (e: ClipboardEvent): void => onCopy(e, false);
    const cut = (e: ClipboardEvent): void => onCopy(e, true);
    root.addEventListener('beforeinput', onBeforeInput);
    root.addEventListener('paste', onPaste);
    root.addEventListener('copy', copy);
    root.addEventListener('cut', cut);
    return () => {
      root.removeEventListener('beforeinput', onBeforeInput);
      root.removeEventListener('paste', onPaste);
      root.removeEventListener('copy', copy);
      root.removeEventListener('cut', cut);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatting]);

  /** A paste or drop: the text goes in as typed would (pairs hide, beside markers it settles). */
  function spliceTextSettled(from: number, to: number, insert: string, caret: number): void {
    const base = held.current;
    const raw = base.slice(0, from) + insert + base.slice(to);
    const next = formatting
      ? liveEdit(from === to ? base : base.slice(0, from) + base.slice(to), raw, {
          start: caret,
          end: caret,
        })
      : { text: raw, start: caret, end: caret };
    applyText(next, 'paste');
  }

  useImperativeHandle(ref, () => ({
    element(): HTMLElement | null {
      return editorRef.current;
    },
    insertText(text: string): void {
      const at = savedSel.current ?? { start: held.current.length, end: held.current.length };
      const caret = at.start + text.length;
      spliceTextSettled(at.start, at.end, text, caret);
      // The picker hands focus back to its button as it closes; take it back
      // on the next frame, caret after the insert.
      const root = editorRef.current;
      requestAnimationFrame(() => {
        const sel = savedSel.current;
        if (root === null || !root.isConnected || sel === null) return;
        restoreSelection(root, sel.start, sel.end);
      });
    },
  }));

  const matches = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    return members.filter(
      (m) =>
        m.name.toLowerCase().includes(needle) || (m.username ?? '').toLowerCase().includes(needle),
    );
  }, [members, query]);

  const open = query !== null && matches.length > 0;

  // The list hangs above the writing box, exactly where chat's @ picker sits
  // (bottom-full on the box, above its row in the phone editor).
  useLayoutEffect(() => {
    if (!open || !bare) return;
    const slot =
      editorRef.current
        ?.closest('[data-writing-box]')
        ?.querySelector<HTMLElement>('[data-writing-list-slot]') ?? null;
    if (slot !== listSlot) setListSlot(slot);
  }, [open, bare, listSlot]);

  function refreshQuery(): void {
    const root = editorRef.current;
    if (root === null) return;
    const sel = selectionNow(root);
    if (sel === null) {
      setQuery(null);
      return;
    }
    // Chips read as one object character, so a chip just before the caret
    // never reads as an open "@" run.
    const before = held.current.slice(0, sel.start).replace(TOKEN_SPLIT_ALL, '￼');
    setQuery(activeMentionQuery(stripHiddenMarkers(before)));
    setHighlight(0);
  }

  function selectMember(member: MentionCandidate): void {
    const root = editorRef.current;
    if (root === null) return;
    const sel = selectionNow(root) ?? savedSel.current;
    if (sel === null) return;
    const removeLen = (query ?? '').length + 1; // include the trigger '@'
    const from = Math.max(0, sel.start - removeLen);
    const token = `@[${member.id}] `;
    setQuery(null);
    setHighlight(0);
    spliceText(from, sel.end, token, from + token.length, from + token.length);
  }

  // Escape ends the @ query (and so the picker) as the top layer, so Escape in a
  // composer inside a Sheet closes the picker and leaves the Sheet open.
  useEscapeLayer(query !== null, () => setQuery(null));

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const native = event.nativeEvent;
    // The editor's own Undo / Redo (a redraw wipes the browser's).
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (
      mod &&
      !event.altKey &&
      (key === 'z' || (key === 'y' && event.ctrlKey && !event.metaKey)) &&
      !native.isComposing
    ) {
      event.preventDefault();
      stepHistory(key === 'y' || event.shiftKey ? 1 : -1);
      return;
    }
    // Arrows step over hidden markers (a caret never stops on nothing).
    if (
      formatting &&
      (event.key === 'ArrowLeft' || event.key === 'ArrowRight') &&
      !mod &&
      !event.altKey &&
      !event.shiftKey &&
      !native.isComposing
    ) {
      const root = editorRef.current;
      const sel = root !== null ? selectionNow(root) : null;
      if (root !== null && sel !== null && sel.start === sel.end) {
        const dir = event.key === 'ArrowLeft' ? -1 : 1;
        const text = held.current;
        if (isHiddenMarker(dir < 0 ? text[sel.start - 1] : text[sel.start])) {
          event.preventDefault();
          const next = stepOverHidden(text, sel.start, dir);
          restoreSelection(root, next, next);
          return;
        }
      }
    }
    // The mention list owns Return while it is open.
    if (!(open && event.key === 'Enter') && formatKeys(event)) return;
    if (!open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => stepActive(h, matches.length, event.key as 'ArrowUp' | 'ArrowDown'));
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const member = matches[highlight];
      if (member !== undefined) selectMember(member);
    }
  }

  const rows = matches.map(pickerMember);
  const list = open ? (
    // Chat's @ picker, as is: the same list in comments as in chat.
    <div
      data-mention-list=""
      className={cn(
        'absolute left-0 right-0 z-sticky',
        bare ? 'bottom-full mb-2' : 'top-full mt-1',
      )}
    >
      <MentionPicker
        members={rows}
        active={Math.min(highlight, Math.max(rows.length - 1, 0))}
        listId={listId}
        onPick={(picked) => {
          const member = matches.find((m) => m.id === picked.userId);
          if (member !== undefined) selectMember(member);
        }}
      />
    </div>
  ) : null;

  return (
    <div className={bare ? 'relative min-w-0 flex-1 self-center' : 'relative'}>
      <div
        ref={editorRef}
        role="textbox"
        aria-label="Comment body"
        aria-multiline="true"
        {...mentionComboboxProps(listId, rows.length, highlight)}
        contentEditable
        suppressContentEditableWarning
        data-live-format={formatting ? '' : undefined}
        data-placeholder={placeholder}
        onInput={() => {
          if (composing.current) return;
          settle(editKind.current);
          editKind.current = 'edit';
        }}
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
          settle('type');
        }}
        onKeyUp={refreshQuery}
        onMouseUp={refreshQuery}
        onFocus={onFocus}
        onKeyDown={onKeyDown}
        className={bare ? BARE_EDITOR : FIELD_EDITOR}
      />
      {/* In a writing box the list goes to its slot (above the box); elsewhere
          it hangs on the field, as before. */}
      {list !== null && bare && listSlot !== null ? createPortal(list, listSlot) : list}
    </div>
  );
});
