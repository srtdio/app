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
 *  what the user sees and the server's length / parse rules behave predictably. */
function normalizeSpaces(text: string): string {
  return text.replace(/\u00a0/g, ' ');
}

/**
 * Serialize the composer to the body string the server stores: each immediate
 * text node contributes its text verbatim; each mention chip span contributes
 * `@[<uuid>]` (its data-mention-id); concatenation is in document order. Any
 * other element falls back to its text so stray markup never drops content.
 */
export function serializeComposer(root: HTMLElement): string {
  let out = '';
  root.childNodes.forEach((node) => {
    if (node.nodeType === TEXT_NODE) {
      out += normalizeSpaces(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType === ELEMENT_NODE) {
      const el = node as HTMLElement;
      const id = el.dataset?.mentionId;
      if (id !== undefined && id !== '') out += `@[${id}]`;
      else out += normalizeSpaces(el.textContent ?? '');
    }
  });
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

interface MentionInputProps {
  members: MentionCandidate[];
  placeholder: string;
  autoFocus?: boolean;
  onChange: (body: string) => void;
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
}: MentionInputProps): ReactElement {
  const editorRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

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
