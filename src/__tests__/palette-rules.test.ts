// Guard: Sorted is black, white and greys (Linear neutrals) plus three status
// colours: amber = Review, green = Approved / read / unread, red = errors and
// Reject. No violet or blue anywhere, app, homepage, emails or icons.
//
// Blue or violet means a hex or rgb() colour with an HSL hue of 190 to 320
// degrees and a saturation above 0.25, or any Tailwind blue, indigo, violet,
// purple, sky or cyan class. Test files and the generated emoji data are out of
// scope. Every hit prints as file:line.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

function walk(dir: string, keep: (rel: string) => boolean): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (name === 'node_modules' || name.startsWith('.')) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path, keep);
    const rel = relative(REPO, path).split(sep).join('/');
    return keep(rel) ? [rel] : [];
  });
}

const isTest = (rel: string): boolean =>
  /\.(test|spec)\.tsx?$/.test(rel) || rel.includes('/__tests__/');
const isEmojiData = (rel: string): boolean =>
  rel === 'src/components/chat/emoji-data.ts' || rel === 'src/lib/chat/emoji-list.ts';

const SCOPE: readonly string[] = [
  ...walk(join(REPO, 'src'), (rel) => /\.(ts|tsx|css)$/.test(rel)),
  ...walk(join(REPO, 'packages'), (rel) => /^packages\/[^/]+\/src\/.*\.ts$/.test(rel)),
  ...walk(join(REPO, 'supabase/functions'), (rel) => rel.endsWith('.ts')),
  ...walk(join(REPO, 'supabase/templates'), (rel) =>
    /^supabase\/templates\/[^/]+\.html$/.test(rel),
  ),
  ...walk(join(REPO, 'public'), (rel) => /^public\/[^/]+\.svg$/.test(rel)),
  'index.html',
].filter((rel) => !isTest(rel) && !isEmojiData(rel));

/** True for a blue or violet colour: hue 190 to 320, HSL saturation above 0.25. */
function isBlueOrViolet(r: number, g: number, b: number): boolean {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return false;
  const light = (max + min) / 2;
  const sat = delta / (1 - Math.abs(2 * light - 1));
  let hue: number;
  if (max === rn) hue = 60 * (((gn - bn) / delta + 6) % 6);
  else if (max === gn) hue = 60 * ((bn - rn) / delta + 2);
  else hue = 60 * ((rn - gn) / delta + 4);
  return hue >= 190 && hue <= 320 && sat > 0.25;
}

// "&#109;" is an HTML entity, not a colour.
const HEX = /(?<![&\w])#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/g;
const RGB = /rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/g;
const TAILWIND = /-(?:blue|indigo|violet|purple|sky|cyan)-(?:50|[1-9]00|950)\b/g;

function hexRgb(raw: string): [number, number, number] {
  const full = raw.length <= 4 ? [...raw.slice(0, 3)].map((c) => c + c).join('') : raw.slice(0, 6);
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as [number, number, number];
}

/** Every blue or violet colour on one line. */
function lineHits(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(HEX)) {
    if (isBlueOrViolet(...hexRgb(m[1] ?? ''))) out.push(m[0]);
  }
  for (const m of line.matchAll(RGB)) {
    if (isBlueOrViolet(Number(m[1]), Number(m[2]), Number(m[3]))) out.push(m[0]);
  }
  for (const m of line.matchAll(TAILWIND)) out.push(m[0].slice(1));
  return out;
}

describe('palette rules: no violet or blue', () => {
  it('the detector flags the old violet and blue, and passes the neutrals and status colours', () => {
    for (const hex of ['5e6ad2', '6f79e3', '5a3fe0', '2457D6', '7a5ea8', '838bec']) {
      expect(isBlueOrViolet(...hexRgb(hex)), hex).toBe(true);
    }
    for (const hex of [
      '08090a',
      'f7f8f8',
      'e5e5e6',
      '0f1011',
      '8a8f98',
      '26282c',
      'f1f2f4',
      '4cb782',
      '2f7d55',
      'f2c94c',
      'eb5757',
      'c2392b',
      '95601f',
    ]) {
      expect(isBlueOrViolet(...hexRgb(hex)), hex).toBe(false);
    }
    expect(lineHits('className="bg-indigo-500 text-sky-400"')).toEqual(['indigo-500', 'sky-400']);
    expect(lineHits('rgba(94, 106, 210, 0.1)')).toHaveLength(1);
    expect(lineHits('"&#109;" -> "m"')).toEqual([]);
  });

  it('scans the app, packages, edge functions, templates, public svgs and index.html', () => {
    expect(SCOPE).toContain('src/index.css');
    expect(SCOPE).toContain('src/components/home/home.css');
    expect(SCOPE).toContain('packages/inbox/src/catchup.ts');
    expect(SCOPE).toContain('supabase/functions/invite-send/handler.ts');
    expect(SCOPE).toContain('public/favicon.svg');
    expect(SCOPE).toContain('index.html');
  });

  it('no file in scope carries a blue or violet colour', () => {
    const offenders: string[] = [];
    for (const rel of SCOPE) {
      const lines = readFileSync(join(REPO, rel), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const found = lineHits(line);
        if (found.length > 0) offenders.push(`${rel}:${i + 1}: ${found.join(', ')}`);
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
