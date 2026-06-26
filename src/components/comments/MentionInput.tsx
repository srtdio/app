// A contentEditable comment composer with inline @-mention chips. Typing "@" at
// the start of the text or right after whitespace opens a dropdown of the
// workspace's members, filtered by the run typed after the @. Selecting a member
// drops a non-editable chip (rendered "@Name", accent token styling) carrying the
// member id in data-mention-id; on every input the SERIALIZED body is reported
// through onChange, with each chip becoming the existing @[uuid] token so
// comment_create / @srtdio/comments parse, validate, and notify unchanged.
//
// Two pure functions (serializeComposer, activeMentionQuery) carry the logic that
// can be unit-tested without a DOM; caret / selection behaviour lives only in the
// component and is exercised in the browser, never in jsdom.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactElement } from 'react';
import { Avatar } from '@/components/ui/Avatar';
import type { MentionCandidate } from '@/components/comments/useMentionCandidates';

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
  return out;
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
      chip.textContent = `@${candidate.name}`;
      nodes.push(chip);
    } else {
      nodes.push(factory.createTextNode(match[0]));
    }
    last = start + match[0].length;
  }
  if (last < body.length) nodes.push(factory.createTextNode(body.slice(last)));
  return nodes;
}

interface MentionInputProps {
  members: MentionCandidate[];
  placeholder: string;
  autoFocus?: boolean;
  onChange: (body: string) => void;
  /** Seed the editor once on mount (e.g. a reply pre-tagging the author). When
   *  empty / undefined the editor mounts blank and uncontrolled, exactly as before. */
  initialBody?: string | undefined;
}

/** The text from the start of the editable to the caret, or null if unavailable. */
function textBeforeCaret(root: HTMLElement): string | null {
  const sel = window.getSelection();
  if (sel === null || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;
  const pre = range.cloneRange();
  pre.selectNodeContents(root);
  pre.setEnd(range.startContainer, range.startOffset);
  return normalizeSpaces(pre.toString());
}

export function MentionInput({
  members,
  placeholder,
  autoFocus = false,
  onChange,
  initialBody,
}: MentionInputProps): ReactElement {
  const editorRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  // Seed the editor once per mount when an initialBody is given: build its chips
  // and text, drop the caret AFTER the inserted content, focus, and emit so the
  // parent body state is primed. Guarded by a ref so it never re-runs.
  useEffect(() => {
    if (seeded.current) return;
    const root = editorRef.current;
    if (root === null || initialBody === undefined || initialBody === '') return;
    seeded.current = true;
    for (const node of buildInitialContent(initialBody, members, document)) {
      root.appendChild(node);
    }
    const range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
    const sel = window.getSelection();
    if (sel !== null) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    root.focus();
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

  const matches = useMemo(() => {
    if (query === null) return [];
    const needle = query.toLowerCase();
    return members.filter((m) => m.name.toLowerCase().includes(needle));
  }, [members, query]);

  const open = query !== null && matches.length > 0;

  function emit(): void {
    if (editorRef.current !== null) onChange(serializeComposer(editorRef.current));
  }

  function refreshQuery(): void {
    if (editorRef.current === null) return;
    const before = textBeforeCaret(editorRef.current);
    const next = before === null ? null : activeMentionQuery(before);
    setQuery(next);
    setHighlight(0);
  }

  function selectMember(member: MentionCandidate): void {
    const root = editorRef.current;
    const sel = window.getSelection();
    if (root === null || sel === null || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const container = range.startContainer;
    const removeLen = (query ?? '').length + 1; // include the trigger '@'
    if (container.nodeType === TEXT_NODE) {
      range.setStart(container, Math.max(0, range.startOffset - removeLen));
    }
    range.deleteContents();

    const chip = document.createElement('span');
    chip.setAttribute('contenteditable', 'false');
    chip.dataset.mentionId = member.id;
    chip.className = 'rounded px-1 font-medium text-accent bg-accent-soft';
    chip.textContent = `@${member.name}`;
    const space = document.createTextNode(' ');

    range.insertNode(space);
    range.insertNode(chip);

    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    sel.removeAllRanges();
    sel.addRange(after);

    setQuery(null);
    setHighlight(0);
    root.focus();
    emit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (!open) {
      if (event.key === 'Escape' && query !== null) setQuery(null);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => (h + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const member = matches[highlight];
      if (member !== undefined) selectMember(member);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setQuery(null);
    }
  }

  return (
    <div className="relative">
      <div
        ref={editorRef}
        role="textbox"
        aria-label="Comment body"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder}
        onInput={() => {
          emit();
          refreshQuery();
        }}
        onKeyUp={() => refreshQuery()}
        onMouseUp={() => refreshQuery()}
        onKeyDown={onKeyDown}
        className="w-full whitespace-pre-wrap break-words rounded-md border border-border bg-panel-2 px-3 py-2.5 text-sm text-fg outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft min-h-[74px] empty:before:content-[attr(data-placeholder)] before:pointer-events-none before:text-fg-3"
      />

      {open ? (
        <ul className="absolute left-0 right-0 z-20 mt-1 max-h-64 overflow-auto rounded-md border border-border bg-panel-2 py-1 shadow-lg">
          {matches.map((member, index) => (
            <li key={member.id}>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  selectMember(member);
                }}
                onMouseEnter={() => setHighlight(index)}
                className={
                  index === highlight
                    ? 'flex min-h-[44px] w-full items-center gap-2 px-3 text-left bg-panel-3'
                    : 'flex min-h-[44px] w-full items-center gap-2 px-3 text-left hover:bg-panel-3'
                }
              >
                <Avatar
                  name={member.name}
                  size="md"
                  {...(member.avatarUrl !== null ? { src: member.avatarUrl } : {})}
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {member.name}
                </span>
                {member.role !== '' ? (
                  <span className="shrink-0 text-xs text-fg-3">{member.role}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
