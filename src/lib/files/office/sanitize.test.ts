// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DOC_CSP, DOC_SANDBOX, buildSrcdoc, safeColor, sanitizeDocHtml } from './sanitize';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

describe('sanitizeDocHtml', () => {
  it('strips script, iframe, object, embed, form, link, base and meta refresh', () => {
    const out = sanitizeDocHtml(
      '<p>ok</p><script>alert(1)</script><iframe src="https://x.example"></iframe>' +
        '<object data="x.swf"></object><embed src="x.swf"><form action="https://x.example"><input></form>' +
        '<link rel="stylesheet" href="https://x.example/a.css"><base href="https://x.example/">' +
        '<meta http-equiv="refresh" content="0;url=https://x.example"><style>p{background:url(https://x.example)}</style>',
    );
    expect(out).toBe('<p>ok</p>');
  });

  it('strips every on* handler and style attributes', () => {
    const out = sanitizeDocHtml(
      `<p onclick="alert(1)" onmouseover="x()" style="background:url(https://x.example)">a</p><img src="${PNG}" onerror="alert(1)" onload="x()">`,
    );
    expect(out).not.toMatch(/on\w+=|style=/i);
    expect(out).toContain('<p>a</p>');
    expect(out).toContain(`<img src="${PNG}">`);
  });

  it('links become plain text: javascript:, vbscript:, data:text and https all go', () => {
    const out = sanitizeDocHtml(
      '<a href="javascript:alert(1)">one</a> <a href="vbscript:msgbox(1)">two</a> ' +
        '<a href="data:text/html,<script>alert(1)</script>">three</a> <a href="https://x.example">four</a>',
    );
    expect(out).toBe('one two three four');
  });

  it('external and non-raster images are removed; inline rasters stay', () => {
    const out = sanitizeDocHtml(
      '<img src="https://tracker.example/p.png"><img src="http://x.example/p.gif">' +
        '<img src="data:text/html;base64,PHNjcmlwdD4="><img src="data:image/svg+xml;base64,PHN2Zz4=">' +
        `<img src="javascript:alert(1)"><img src="${PNG}" width="10" height="20" alt="">`,
    );
    expect(out).toBe(`<img src="${PNG}" width="10" height="20" alt="">`);
  });

  it('svg and its foreignObject are removed with their content', () => {
    const out = sanitizeDocHtml(
      '<p>a</p><svg><foreignObject><iframe src="https://x.example"></iframe><p>inside</p></foreignObject></svg>',
    );
    expect(out).not.toMatch(/svg|foreignObject|iframe/i);
  });

  it('keeps the reader vocabulary and only its own classes', () => {
    const out = sanitizeDocHtml(
      '<h1 class="title evil">T</h1><p class="al-c li lv2 x">p</p><table><tbody><tr><td colspan="2" rowspan="x">c</td></tr></tbody></table>',
    );
    expect(out).toBe(
      '<h1 class="title">T</h1><p class="al-c li lv2">p</p><table><tbody><tr><td colspan="2">c</td></tr></tbody></table>',
    );
  });
});

describe('buildSrcdoc', () => {
  it('starts with the CSP meta: nothing loads from the network', () => {
    const doc = buildSrcdoc({
      pages: ['<p>x</p>'],
      paper: '#f4f5f6',
      margins: [0.1, 0.1, 0.1, 0.1],
    });
    expect(DOC_CSP).toBe(
      "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:",
    );
    expect(doc).toContain(`<meta http-equiv="Content-Security-Policy" content="${DOC_CSP}">`);
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<style>'));
    expect(doc).toContain('<div class="page"><p>x</p></div>');
    expect(doc).toContain('background:#f4f5f6');
    expect(doc).not.toMatch(/https?:/);
  });

  it('the paper colour must be a plain colour, else white', () => {
    expect(safeColor(' #f4f5f6 ', '#fff')).toBe('#f4f5f6');
    expect(safeColor('red;}body{background:url(x)', '#fff')).toBe('#fff');
  });

  it('the sandbox is empty: every capability off', () => {
    expect(DOC_SANDBOX).toBe('');
  });
});
