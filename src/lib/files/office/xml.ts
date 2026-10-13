// A narrow XML reader for OOXML parts, run inside the office Worker only.
//
// Linear time (indexOf scans, no backtracking regex), no recursion, and no DTD
// support at all: a document with <!DOCTYPE or <!ENTITY is refused, so entity
// expansion and external entities cannot happen. Only the five predefined
// entities and numeric character references are decoded; anything else stays
// as literal text. Names are reduced to their local part ("w:p" -> "p"), which
// is all the readers need.

export class XmlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlError';
  }
}

export type XmlAttrs = Readonly<Record<string, string>>;

export interface XmlHandler {
  open(name: string, attrs: XmlAttrs, selfClosing: boolean): void;
  close(name: string): void;
  text(text: string): void;
}

/** "w:p" -> "p". Pure. */
function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

const NAMED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** Decode the predefined entities and numeric references; others stay literal. Pure. */
export function decodeEntities(raw: string): string {
  if (raw.indexOf('&') === -1) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf('&', i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(';', amp + 1);
    if (semi === -1 || semi - amp > 12) {
      out += '&';
      i = amp + 1;
      continue;
    }
    const body = raw.slice(amp + 1, semi);
    let decoded: string | null = NAMED[body] ?? null;
    if (decoded === null && body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = hex ? body.slice(2) : body.slice(1);
      const valid = hex ? /^[0-9a-fA-F]{1,6}$/.test(digits) : /^[0-9]{1,7}$/.test(digits);
      const code = valid ? parseInt(digits, hex ? 16 : 10) : NaN;
      if (
        Number.isFinite(code) &&
        code > 0 &&
        code <= 0x10ffff &&
        !(code >= 0xd800 && code <= 0xdfff)
      ) {
        decoded = String.fromCodePoint(code);
      }
    }
    if (decoded === null) {
      out += '&';
      i = amp + 1;
    } else {
      out += decoded;
      i = semi + 1;
    }
  }
  return out;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Parse the attributes inside a start tag (between the name and '>'). */
function parseAttrs(src: string, from: number, to: number): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  let i = from;
  while (i < to) {
    while (i < to && isSpace(src.charCodeAt(i))) i++;
    if (i >= to) break;
    const eq = src.indexOf('=', i);
    if (eq === -1 || eq >= to) throw new XmlError('attribute without value');
    const name = src.slice(i, eq).trim();
    let q = eq + 1;
    while (q < to && isSpace(src.charCodeAt(q))) q++;
    const quote = src[q];
    if (quote !== '"' && quote !== "'") throw new XmlError('unquoted attribute');
    const end = src.indexOf(quote, q + 1);
    if (end === -1 || end > to) throw new XmlError('unterminated attribute');
    if (name !== '') attrs[localName(name)] = decodeEntities(src.slice(q + 1, end));
    i = end + 1;
  }
  return attrs;
}

/** Find the '>' closing a start tag, skipping quoted attribute values. */
function tagEnd(src: string, from: number): number {
  let quote: string | null = null;
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

/** Stream one XML document through `handler`. Throws XmlError on malformed input or a DTD. */
export function scanXml(src: string, handler: XmlHandler, maxDepth = 256): void {
  let i = 0;
  let depth = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      if (depth > 0) handler.text(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i && depth > 0) handler.text(decodeEntities(src.slice(i, lt)));
    const next = src[lt + 1];
    if (next === '?') {
      const end = src.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (next === '!') {
      if (src.startsWith('<!--', lt)) {
        const end = src.indexOf('-->', lt + 4);
        if (end === -1) throw new XmlError('unterminated comment');
        i = end + 3;
        continue;
      }
      if (src.startsWith('<![CDATA[', lt)) {
        const end = src.indexOf(']]>', lt + 9);
        if (end === -1) throw new XmlError('unterminated CDATA');
        if (depth > 0) handler.text(src.slice(lt + 9, end));
        i = end + 3;
        continue;
      }
      // <!DOCTYPE, <!ENTITY and the rest: never in OOXML, never expanded.
      throw new XmlError('DTD not allowed');
    }
    if (next === '/') {
      const end = src.indexOf('>', lt + 2);
      if (end === -1) throw new XmlError('unterminated end tag');
      if (depth === 0) throw new XmlError('unbalanced end tag');
      depth--;
      handler.close(localName(src.slice(lt + 2, end).trim()));
      i = end + 1;
      continue;
    }
    const end = tagEnd(src, lt + 1);
    if (end === -1) throw new XmlError('unterminated start tag');
    const selfClosing = src[end - 1] === '/';
    const inner = selfClosing ? end - 1 : end;
    let nameEnd = lt + 1;
    while (nameEnd < inner && !isSpace(src.charCodeAt(nameEnd))) nameEnd++;
    const name = localName(src.slice(lt + 1, nameEnd));
    if (name === '') throw new XmlError('empty tag name');
    const attrs = parseAttrs(src, nameEnd, inner);
    if (!selfClosing) {
      depth++;
      if (depth > maxDepth) throw new XmlError('too deep');
    }
    handler.open(name, attrs, selfClosing);
    if (selfClosing) handler.close(name);
    i = end + 1;
  }
  if (depth !== 0) throw new XmlError('unclosed element');
}

/** A small element tree, for parts the readers walk more than once (document.xml). */
export interface XmlNode {
  name: string;
  attrs: XmlAttrs;
  children: Array<XmlNode | string>;
}

/** Parse a whole part into a tree, capped at `maxNodes` elements. */
export function parseXmlTree(src: string, maxNodes = 2_000_000): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [] };
  const stack: XmlNode[] = [root];
  let count = 0;
  scanXml(src, {
    open(name, attrs) {
      count++;
      if (count > maxNodes) throw new XmlError('too many elements');
      const node: XmlNode = { name, attrs, children: [] };
      stack[stack.length - 1]?.children.push(node);
      stack.push(node);
    },
    close() {
      stack.pop();
    },
    text(text) {
      stack[stack.length - 1]?.children.push(text);
    },
  });
  return root;
}

/** The first child element named `name`, or null. Pure. */
export function child(node: XmlNode, name: string): XmlNode | null {
  for (const c of node.children) {
    if (typeof c !== 'string' && c.name === name) return c;
  }
  return null;
}

/** Every child element named `name`. Pure. */
export function children(node: XmlNode, name: string): XmlNode[] {
  const out: XmlNode[] = [];
  for (const c of node.children) {
    if (typeof c !== 'string' && c.name === name) out.push(c);
  }
  return out;
}

/** The first descendant named `name` (depth first, iterative), or null. Pure. */
export function descendant(node: XmlNode, name: string): XmlNode | null {
  const stack: XmlNode[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (cur === undefined) break;
    if (cur !== node && cur.name === name) return cur;
    for (let i = cur.children.length - 1; i >= 0; i--) {
      const c = cur.children[i];
      if (c !== undefined && typeof c !== 'string') stack.push(c);
    }
  }
  return null;
}
